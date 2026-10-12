'use strict';

// MediaImportActions — the stage handlers for pipelines/usb-sd-birds (and any
// future media-import pipeline shaped the same way). Each stage operates on
// the whole discovered batch (payload.files), not one file per dispatch call
// — artifact.create is one-artifact-per-call by design, so preserveMedia is
// its own capability rather than reusing it in a loop the caller can't see.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const Artifact         = require('../domain/Artifact');
const ArtifactMedia    = require('../domain/ArtifactMedia');
const ArtifactRelation = require('../domain/ArtifactRelation');
const Packet            = require('../core/Packet');
const { evaluateRules } = require('../core/RuleEvaluator');
const { toSlug }        = require('../domain/slug');

// Cache lives alongside whichever vessel db is actually active — not a
// fixed path — so two vessels (two --db files) never see each other's
// cache, and a fresh vessel never shows stale data from a previous one.
// SqliteAdapter exposes its own file path; PostgresAdapter has no local
// vessel directory concept, so that case falls back to the old fixed default.
function _defaultCacheDir(pipelineSlug) {
  const dbAdapter = Packet.service('db');
  const vesselDir = dbAdapter?.dbPath ? path.dirname(dbAdapter.dbPath) : path.resolve(__dirname, '../arks/default');
  return path.join(vesselDir, 'cache', pipelineSlug);
}

const EXT_BY_TYPE = {
  image: ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.gif'],
  video: ['.mp4', '.mov', '.avi', '.webm'],
  audio: ['.mp3', '.wav', '.m4a'],
};

function _mediaTypeForExt(ext) {
  ext = ext.toLowerCase();
  for (const [type, exts] of Object.entries(EXT_BY_TYPE)) {
    if (exts.includes(ext)) return type;
  }
  return null;
}

// Recursive — real camera/card-reader sources nest media under a DCIM/<folder>/
// structure (e.g. DCIM/102_PANA/*.JPG), never at the source root. Dot-entries
// (.Trashes, .fseventsd, .DS_Store — filesystem metadata FAT/exFAT cards
// always carry) are skipped rather than walked.
function _walkDir(dir, media_types) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(..._walkDir(full, media_types));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const mediaType = _mediaTypeForExt(ext);
    if (!mediaType) continue;
    if (media_types?.length && !media_types.includes(mediaType)) continue;

    const stat = fs.statSync(full);
    files.push({
      source_path: full,
      basename:    path.basename(entry.name, ext),
      ext:         ext.replace('.', ''),
      media_type:  mediaType,
      file_size:   stat.size,
      mtime:       stat.mtime.toISOString(),
    });
  }
  return files;
}

// ── source.discover — merge ───────────────────────────────────────────────
// Capability: filesystem.read (declared in ACTION_REGISTRY) — the only
// capability this whole pipeline needs that touches the host filesystem
// directly rather than going through the db adapter.
async function discoverSource(ctx, payload, packet) {
  const { path: sourcePath, media_types } = payload;
  if (!sourcePath) throw new Error('path is required');
  if (!fs.existsSync(sourcePath)) throw new Error(`Source path does not exist: ${sourcePath}`);

  const files = _walkDir(sourcePath, media_types);

  packet.log.push(`source.discover → ${files.length} file(s) under ${sourcePath} (recursive)`);
  return { data: { files } };
}

// ── source.filter — merge ─────────────────────────────────────────────────
// Every discovered file is preserved off the source device and classified,
// full stop. This used to gate classification on capture_year matching a
// known-unset-camera-clock year (2004), on the theory that only the
// misdated subset needed an LLM to figure out what it was. That gate
// silently depended on the camera clock staying broken — the moment it
// reads correct dates again, every real bird photo skips classification
// and lands in the wrong bucket (see routing.yaml's
// not-flagged-for-classification rule). Not worth the fragility: every
// card import should hit the classifier, always.
async function filterSource(ctx, payload, packet) {
  const { files = [] } = payload;

  const tagged = files.map(f => ({ ...f, needs_classification: true }));

  packet.log.push(`source.filter → ${tagged.length} file(s) kept, all flagged for classification`);
  return { data: { files: tagged } };
}

// ── media.identify — merge ────────────────────────────────────────────────
// discover already sets media_type from the extension; this capability
// exists separately so a future provider (real magic-byte sniffing) can
// satisfy it without touching discover. Pass-through today.
async function identifyMedia(ctx, payload, packet) {
  const { files = [] } = payload;
  packet.log.push(`media.identify → ${files.length} file(s), pass-through`);
  return { data: { files } };
}

// ── media.fingerprint — merge ─────────────────────────────────────────────
async function fingerprintMedia(ctx, payload, packet) {
  const { files = [] } = payload;
  const fingerprinted = files.map(f => {
    const bytes = fs.readFileSync(f.source_path);
    const content_hash = crypto.createHash('sha256').update(bytes).digest('hex');
    return { ...f, content_hash };
  });
  packet.log.push(`media.fingerprint → ${fingerprinted.length} file(s)`);
  return { data: { files: fingerprinted } };
}

// ── artifact.resolve_duplicate — merge ────────────────────────────────────
// Checked against artifact_media.content_hash (raw bytes), not
// artifacts.content_hash (a semantic fingerprint over title/type/metadata —
// wrong thing to dedupe media imports against).
async function resolveDuplicate(ctx, payload, packet) {
  const { files = [] } = payload;
  const resolved = [];
  const seenInBatch = new Map(); // content_hash -> source_path of the first file with it, this run

  for (const f of files) {
    const dupInBatch = seenInBatch.get(f.content_hash);
    if (dupInBatch) {
      resolved.push({ ...f, is_duplicate: true, existing_artifact_id: null, existing_media_id: null, existing_classification: null, duplicate_of: dupInBatch });
      continue;
    }

    const { data: existing } = await ArtifactMedia.db
      .from('artifact_media')
      .select('id, artifact_id')
      .eq('content_hash', f.content_hash)
      .limit(1)
      .maybeSingle();

    // A duplicate encounter of a file already classified in a prior run —
    // carry the stored result forward so classifyBatch can inherit it
    // instead of re-spending an LLM call on a photo already resolved.
    let existing_classification = null;
    if (existing) {
      const { data: artifactRow } = await Artifact.db
        .from('artifacts')
        .select('metadata')
        .eq('id', existing.artifact_id)
        .maybeSingle();
      if (artifactRow?.metadata?.likely_subject) {
        existing_classification = {
          likely_subject: artifactRow.metadata.likely_subject,
          confidence:     artifactRow.metadata.confidence ?? null,
        };
      }
    }

    seenInBatch.set(f.content_hash, f.source_path);
    resolved.push({
      ...f,
      is_duplicate:            !!existing,
      existing_artifact_id:    existing?.artifact_id || null,
      existing_media_id:       existing?.id          || null,
      existing_classification,
    });
  }
  const dupCount = resolved.filter(f => f.is_duplicate).length;
  packet.log.push(`artifact.resolve_duplicate → ${dupCount} duplicate(s) of ${resolved.length}`);
  return { data: { files: resolved } };
}

// ── artifact.create (media.preserve role) — side_effect ───────────────────
// One Artifact + one ArtifactMedia (raw content_hash) per non-duplicate file.
// Registered as media.preserve — distinct from artifact.create, which is
// one-artifact-per-call and not shaped for this batch.
//
// artifact_type defaults to 'photo' (the only value every caller used
// before this was parameterized — zero behavior change for usb-sd-birds).
// pipelines/youtube-scenes passes 'scene' via the CLI's --artifact-type
// flag. Per-file f.metadata (e.g. detect_scenes's scene_number/start_time/
// end_time/duration/source_video) is spread onto the artifact's own
// metadata rather than dropped — camera imports never set f.metadata, so
// this is additive only.
async function preserveMedia(ctx, payload, packet) {
  const { files = [], artifact_type = 'photo' } = payload;
  const preserved = [];
  for (const f of files) {
    // A duplicate never gets a new Artifact/ArtifactMedia row, but it still
    // needs to carry the EXISTING ids forward — archive_copy and classify
    // both act on this same file this run (a re-encountered photo still
    // needs archiving to *this* destination and, if never classified
    // before, still needs the LLM). Only artifact CREATION is gated on
    // is_duplicate, not the rest of the pipeline.
    if (f.is_duplicate) {
      preserved.push({ ...f, artifact_id: f.existing_artifact_id, media_id: f.existing_media_id });
      continue;
    }

    const artifact = new Artifact({
      artifact_type,
      title:         f.basename,
      metadata:      { source_mtime: f.mtime, media_type: f.media_type, ext: f.ext, ...(f.metadata || {}) },
      context:       { visibility: 'private' },
    }, { context: ctx });
    await artifact.save();

    const media = new ArtifactMedia({
      artifact_id:  artifact.id,
      media_type:   f.media_type,
      provider:     'local_source',
      url:          f.source_path,
      file_size:    f.file_size,
      content_hash: f.content_hash,
      metadata:     {},
    }, { context: ctx });
    await media.save();

    preserved.push({ ...f, artifact_id: artifact.id, media_id: media.id });
  }
  const created = preserved.filter(f => f.artifact_id && !f.is_duplicate).length;
  packet.log.push(`media.preserve → ${created} artifact(s) created, ${preserved.length - created} skipped (duplicate)`);
  return { data: { files: preserved } };
}

// ── media.pair — merge ────────────────────────────────────────────────────
// Groups files by (directory, basename). Every TIFF gets archival_master +
// needs_classification:false regardless of pairing (classify_batch also
// hard-guards this independently). A matched JPG/TIFF pair additionally
// gets paired_with recorded as provenance (persisted onto the artifact as
// paired_with_source_path) — TIFF classification does NOT inherit the
// JPG's result; a TIFF has no subject of its own to display anywhere.
// RuleEvaluator can't express pairing.yaml's files_share/formats
// conditions (see RuleEvaluator.js's comment on unsupported condition
// shapes), so the actual match runs here, not through evaluateRules.
const JPG_EXTS = new Set(['jpg', 'jpeg']);
const TIF_EXTS = new Set(['tif', 'tiff']);

async function pairMedia(ctx, payload, packet) {
  const { files = [] } = payload;
  const byKey = new Map(); // "<dir>::<basename>" -> files sharing it
  for (const f of files) {
    const key = `${path.dirname(f.source_path)}::${f.basename.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(f);
  }

  const paired = files.map(f => ({ ...f }));
  const bySourcePath = new Map(paired.map(f => [f.source_path, f]));
  let pairCount = 0;

  // TIFF is always the hi-res archival master, cold storage only — never
  // classified (the vision model doesn't decode TIFF reliably anyway) and
  // never uploaded to cloud Storage (see SyncActions.js's isArchivalMaster
  // check). That's true whether or not this batch also has its JPG
  // partner — an orphaned TIFF isn't suddenly fair game for the LLM just
  // because pairing found nothing to inherit a classification from.
  for (const f of paired) {
    if (!TIF_EXTS.has(f.ext.toLowerCase())) continue;
    f.representation_role = 'archival_master';
    f.needs_classification = false;
  }

  for (const group of byKey.values()) {
    const jpg = group.find(f => JPG_EXTS.has(f.ext.toLowerCase()));
    const tif = group.find(f => TIF_EXTS.has(f.ext.toLowerCase()));
    if (!jpg || !tif) continue;

    const jpgEntry = bySourcePath.get(jpg.source_path);
    const tifEntry = bySourcePath.get(tif.source_path);
    jpgEntry.representation_role = 'working_representation';
    tifEntry.paired_with = jpg.source_path;
    pairCount++;
  }

  packet.log.push(`media.pair → ${pairCount} JPG/TIFF pair(s) found; all TIFF classification skipped`);
  return { data: { files: paired } };
}

// ── media.persist_pairing — side_effect ───────────────────────────────────
// pairMedia (above) computes representation_role only in the in-memory
// pipeline payload — it dies with the run unless written to the real
// ArtifactMedia row. pairMedia itself stays capability:null (pure
// observation); this is a separate, capability-gated stage specifically so
// the actual DB write goes through the normal governed path rather than
// being bolted onto an unguarded stage. Runs after archive_copy in stage
// order, so it merges onto whatever metadata (e.g. archived_path) that
// stage already wrote rather than clobbering it.
async function persistRepresentationRoles(ctx, payload, packet) {
  const { files = [] } = payload;
  let updated = 0;
  for (const f of files) {
    if (!f.representation_role || !f.media_id) continue;

    const { data: current } = await ArtifactMedia.db
      .from('artifact_media')
      .select('metadata')
      .eq('id', f.media_id)
      .maybeSingle();

    const media = new ArtifactMedia({ id: f.media_id }, { context: ctx });
    media.assign({
      metadata: {
        ...(current?.metadata || {}),
        representation_role: f.representation_role,
        ...(f.paired_with ? { paired_with_source_path: f.paired_with } : {}),
      },
    });
    await media.save();
    updated++;
  }

  packet.log.push(`media.persist_pairing → ${updated} representation_role(s) persisted`);
  return { data: { updated } };
}

// ── memchart.assess — observe ─────────────────────────────────────────────
// Rule-free on purpose: this stage checks the file's media_type against the
// memchart's own memory.preserve/deprioritize lists. Subject-level judgment
// (is this actually a bird) is classify's job, not memchart's — memchart
// expresses vessel-level intent ("preserve photos"), not per-file content.
async function assessMemchart(ctx, payload, packet) {
  const { files = [], memchart_doc } = payload;
  const preserveSet     = new Set((memchart_doc?.memory?.preserve || []).map(s => s.toLowerCase()));
  const deprioritizeSet = new Set((memchart_doc?.memory?.deprioritize || []).map(s => s.toLowerCase()));

  const assessed = files.map(f => {
    const key = `original_${f.media_type}s`; // original_photos / original_videos / original_audios
    const matched      = preserveSet.has(key) || preserveSet.has(`original_${f.media_type}`);
    const deprioritized = deprioritizeSet.has(f.media_type);
    return { ...f, memchart_matched: matched && !deprioritized };
  });

  packet.log.push(`memchart.assess → ${assessed.filter(f => f.memchart_matched).length}/${assessed.length} matched vessel intent`);
  return { data: { files: assessed } };
}

// ── cache.partition — side_effect ─────────────────────────────────────────
// Evaluates the pipeline's own inlined rules (via the generic RuleEvaluator)
// per file, using route_to_bucket as the outcome. Writes a stub JSON per
// artifact into cache/<pipeline_slug>/<bucket>/ — the human-reviewable,
// disposable workspace; the artifacts themselves are already durable
// (created in the preserve stage) regardless of which bucket they land in.
async function partitionCache(ctx, payload, packet) {
  const { files = [], pipeline_rules = [], pipeline_slug = 'import', cache_dir } = payload;
  const baseDir = cache_dir || _defaultCacheDir(pipeline_slug);

  const buckets = {};
  for (const f of files) {
    const facts = {
      media_type:                     f.media_type,
      // Lowercased — the camera mixes .JPG/.TIF and .jpg/.tif casing, and
      // a routing rule matching on format needs to catch both regardless
      // of representation_role having actually persisted (see
      // routing.yaml's format-based archival-master fallback rule).
      format:                         (f.ext || '').toLowerCase(),
      content_hash:                   { already_exists: f.is_duplicate },
      classified:                     f.classified,
      likely_subject:                 f.likely_subject,
      confidence:                     f.confidence,
      quality_check:                  f.quality_check || null,
      representation_match_confidence: f.representation_match_confidence,
      representation_role:            f.representation_role || null,
    };
    const { result, applied } = evaluateRules(pipeline_rules, facts);
    const bucket = result.route_to_bucket || 'ephemera';
    const stubName = `${f.artifact_id || f.content_hash}.json`;

    // Routing can change between runs (reclassification, a fresher inherited
    // result) — remove any stub this artifact left behind in a DIFFERENT
    // bucket on an earlier run, or it lingers there forever and reappears
    // under `cache.materialize_bucket` for a bucket it no longer belongs to.
    if (fs.existsSync(baseDir)) {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === bucket) continue;
        const stale = path.join(baseDir, entry.name, stubName);
        if (fs.existsSync(stale)) fs.unlinkSync(stale);
      }
    }

    const bucketDir = path.join(baseDir, bucket);
    fs.mkdirSync(bucketDir, { recursive: true });
    const stubPath = path.join(bucketDir, stubName);
    fs.writeFileSync(stubPath, JSON.stringify({
      artifact_id:   f.artifact_id || null,
      media_id:      f.media_id || null,
      source_path:   f.source_path,
      archived_path: f.archived_path || null,
      content_hash:  f.content_hash,
      likely_subject: f.likely_subject,
      confidence:    f.confidence,
      inherited_classification: f.inherited_classification || false,
      bucket,
      rules_applied: applied,
    }, null, 2));

    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }

  packet.log.push(`cache.partition → ${Object.entries(buckets).map(([b, n]) => `${b}:${n}`).join(', ')} at ${baseDir}`);
  return { data: { cache_dir: baseDir, buckets } };
}

// ── media.archive_copy — side_effect ──────────────────────────────────────
// usb_import_plan.md's SOURCE→ARCHIVE separation: copies raw bytes for every
// preserved (non-duplicate) file to durable removable storage, independent
// of whether that file was ever classified — preservation and archiving
// both apply to the whole batch; classification is the only stage scoped to
// the misdated subset. Destination is <dest_root>/ark/<path relative to
// source_root>, mirroring the source's folder structure so filenames a
// camera reuses across folders (e.g. 102_PANA vs 103_PANA) never collide.
// url/content_hash — the raw-source evidence — stay untouched;
// archived_path/archived_at land in metadata only, per "raw source bytes
// are immutable."
async function archiveMedia(ctx, payload, packet) {
  const { media, files = [], source_root, dest_root } = payload;
  if (!dest_root) throw new Error('dest_root is required');

  // Called two ways: directly with a `media` array (ArtifactMedia-shaped —
  // id/url/content_hash), or, as a pipeline stage right after `preserve`,
  // with the same `files` batch every other stage in this file operates on.
  // Map that shape here rather than making every stage upstream know about
  // ArtifactMedia's field names.
  // media_id is present for both new and duplicate files now (preserveMedia
  // carries the existing id forward for duplicates) — a re-encountered
  // photo on a recurring card dump still needs archiving to *this*
  // destination, so archiving is no longer gated on !is_duplicate.
  const items = media || files
    .filter(f => f.media_id)
    .map(f => ({ id: f.media_id, url: f.source_path, content_hash: f.content_hash, metadata: {} }));

  const archived = [];
  const archivedPathByMediaId = new Map();
  for (const m of items) {
    const sourcePath = m.url;
    const sourceBytes = fs.readFileSync(sourcePath);
    const sourceHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    if (m.content_hash && sourceHash !== m.content_hash) {
      throw new Error(`Source bytes changed since fingerprint for ${sourcePath} — refusing to archive`);
    }

    const rel = source_root ? path.relative(source_root, sourcePath) : path.basename(sourcePath);
    const destPath = path.join(dest_root, 'ark', rel);

    // Idempotent per destination: a duplicate re-encountered on a later
    // dump may already be sitting at this exact archive path (same card,
    // same run cadence) — skip the copy, not just the artifact creation.
    const alreadyArchived = fs.existsSync(destPath)
      && crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex') === sourceHash;

    if (!alreadyArchived) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(sourcePath, destPath);

      const destHash = crypto.createHash('sha256').update(fs.readFileSync(destPath)).digest('hex');
      if (destHash !== sourceHash) throw new Error(`Archive copy verification failed for ${sourcePath}`);
    }

    const record = new ArtifactMedia({
      id:       m.id,
      metadata: { ...(m.metadata || {}), archived_path: destPath, archived_at: new Date().toISOString() },
    }, { context: ctx });
    // Packet.save() only writes columns in `dirty`, populated by .set()/
    // .assign() — never by the constructor's data argument (see Packet.js).
    // Without this, `metadata` never lands: ArtifactMedia.prepare() always
    // .set()s updated_at, so dirty is never empty, so the "write everything
    // in data" fallback branch this looked like it was using is dead code.
    record.dirty.add('metadata');
    await record.save();

    archived.push({ id: m.id, source_path: sourcePath, archived_path: destPath, already_archived: alreadyArchived });
    archivedPathByMediaId.set(m.id, destPath);
  }

  // Merge archived_path back onto the shared `files` batch (not just the
  // separate `archived` list) so downstream stages — cache.partition, in
  // particular — can see where the durable copy landed, not just the
  // ephemeral source_path on whatever device is currently attached.
  const filesWithArchivePath = files.length
    ? files.map(f => f.media_id && archivedPathByMediaId.has(f.media_id)
        ? { ...f, archived_path: archivedPathByMediaId.get(f.media_id) }
        : f)
    : undefined;

  packet.log.push(`media.archive_copy → ${archived.length} file(s) to ${path.join(dest_root, 'ark')}`);
  return { data: { archived, ...(filesWithArchivePath ? { files: filesWithArchivePath } : {}) } };
}

// ── cache.materialize_bucket — side_effect ────────────────────────────────
// Turns one bucket's JSON stubs (cache.partition's output — provenance, not
// browsable media) into an actual folder of the real files, so reviewing
// "birds" means opening Finder on real photos, not reading JSON one at a
// time. Prefers archived_path (the durable SD copy) over source_path (the
// original device, which may already be disconnected by review time) —
// falls back to source_path only when archive_copy hasn't run yet, e.g.
// while the SD archive destination isn't writable.
async function materializeBucket(ctx, payload, packet) {
  const { pipeline_slug, bucket, cache_dir } = payload;
  if (!pipeline_slug) throw new Error('pipeline_slug is required');
  if (!bucket) throw new Error('bucket is required');

  const baseDir = cache_dir || _defaultCacheDir(pipeline_slug);
  const bucketDir = path.join(baseDir, bucket);
  if (!fs.existsSync(bucketDir)) throw new Error(`No cache bucket at ${bucketDir} — run the pipeline first`);

  const mediaDir = path.join(bucketDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const stubFiles = fs.readdirSync(bucketDir).filter(f => f.endsWith('.json'));
  const copied = [];
  const missing = [];

  for (const stubFile of stubFiles) {
    const stub = JSON.parse(fs.readFileSync(path.join(bucketDir, stubFile), 'utf8'));
    const source = stub.archived_path || stub.source_path;
    if (!source || !fs.existsSync(source)) {
      missing.push({ stub: stubFile, source_path: stub.source_path, archived_path: stub.archived_path });
      continue;
    }
    const destName = `${path.basename(source, path.extname(source))}${path.extname(source)}`;
    const destPath = path.join(mediaDir, destName);
    fs.copyFileSync(source, destPath);
    copied.push({ artifact_id: stub.artifact_id, dest: destPath, from: stub.archived_path ? 'archive' : 'source_device' });
  }

  packet.log.push(`cache.materialize_bucket → ${copied.length} file(s) into ${mediaDir}${missing.length ? `, ${missing.length} unavailable` : ''}`);
  return { data: { media_dir: mediaDir, copied: copied.length, missing } };
}

// ── cache.promote_bucket — side_effect ────────────────────────────────────
// "Publish" step 1 of 2 (see sync.push for step 2): turns a reviewed cache
// bucket into a real, durable local Ark containing its artifacts — cache
// stubs are disposable and ungrouped; pipeline artifacts get no Ark
// membership at creation time (media.preserve creates them directly via the
// domain class, bypassing artifact.create's ephemera-placement). Idempotent
// by slug (not ark.create's own resolveSlug, which deliberately
// disambiguates a taken slug into "birds-2" — wrong here) and add-only on
// membership: never removes a relation for an artifact that moved buckets
// on a later run, since that could silently undo manual curation done in
// an Ark UI after an earlier promote.
async function promoteBucket(ctx, payload, packet) {
  const { pipeline_slug, bucket, title, cache_dir } = payload;
  if (!pipeline_slug) throw new Error('pipeline_slug is required');
  if (!bucket) throw new Error('bucket is required');

  const baseDir = cache_dir || _defaultCacheDir(pipeline_slug);
  const bucketDir = path.join(baseDir, bucket);
  if (!fs.existsSync(bucketDir)) throw new Error(`No cache bucket at ${bucketDir} — run the pipeline first`);

  // Stub filenames are artifact_id/content_hash — effectively random
  // relative to the order cache.partition actually processed files in
  // (confirmed live: a 38-scene video promoted in near-arbitrary order,
  // not scene order). Sorting by the stub file's own mtime recovers that
  // original order (partition writes them sequentially in payload.files
  // order) without cache.partition needing to know anything
  // pipeline-specific like a scene number.
  const stubFiles = fs.readdirSync(bucketDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(bucketDir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(f => f.name);
  const artifactIds = new Set();
  for (const stubFile of stubFiles) {
    const stub = JSON.parse(fs.readFileSync(path.join(bucketDir, stubFile), 'utf8'));
    if (stub.artifact_id) artifactIds.add(stub.artifact_id);
  }

  const slug = toSlug(bucket);
  const [existingArk] = await Artifact.query({ artifact_type: 'ark', filters: [['slug', 'eq', slug]] }, ctx);

  let ark;
  if (existingArk) {
    ark = existingArk;
  } else {
    const arkTitle = title || (bucket.charAt(0).toUpperCase() + bucket.slice(1));
    const created = new Artifact({
      artifact_type: 'ark',
      title:  arkTitle,
      slug,
      status: 'published',
      context: { visibility: 'private' },
    }, { context: ctx });
    await created.save();
    ark = created.data;
  }

  const existingRels = await ArtifactRelation.findBySource(ark.id, 'contains');
  const existingTargets = new Set((existingRels || []).map(r => r.target_artifact_id));

  let added = 0;
  for (const artifactId of artifactIds) {
    if (existingTargets.has(artifactId)) continue;
    const order_index = (await ArtifactRelation.maxOrderIndex(ark.id, 'contains')) + 1;
    const rel = new ArtifactRelation({
      source_artifact_id: ark.id,
      target_artifact_id: artifactId,
      relation_type:      'contains',
      order_index,
    }, { context: ctx });
    await rel.save();
    added++;
  }

  const already_member = artifactIds.size - added;
  packet.log.push(`cache.promote_bucket → ark:${ark.id} "${ark.title}", ${added} added, ${already_member} already present`);
  return { data: { ark, added, already_member } };
}

module.exports = {
  discoverSource, filterSource, identifyMedia, fingerprintMedia,
  resolveDuplicate, preserveMedia, pairMedia, assessMemchart, partitionCache, archiveMedia,
  materializeBucket, persistRepresentationRoles, promoteBucket,
};
