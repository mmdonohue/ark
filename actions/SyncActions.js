'use strict';

// SyncActions — explicit, governed operation for pushing local artifacts
// into the shared Postgres/Supabase project. Deliberately NOT automatic —
// per the use-case docs: "synchronization is a new governed operation
// rather than restoration of the ARK's identity" (ark_use_case.md #22).
//
// Requires ark_id or artifact_ids[] — there is no "sync everything" mode.
// A local ARK accumulates test/throwaway artifacts; syncing without an
// explicit scope would push all of it into shared infrastructure.
//
// Bypasses Packet/Manifest on the destination side, on purpose. Packet.manifest
// is a process-wide singleton bound to whichever db adapter booted this
// session (SQLite for local CLI runs). Sync needs to read from the *active*
// adapter (local) and write to a different, fixed one (the real Supabase
// project) at the same time — something the single-active-adapter model
// can't express. This is the one narrow, documented exception to "everything
// goes through Packet.db."

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const Artifact = require('../domain/Artifact');
const ArtifactMedia = require('../domain/ArtifactMedia');
const StorageAdapter = require('../adapters/storage');
const { uploadImageBytes } = require('../domain/mediaStorage');

const SYNC_MIN_RANK = 100; // owner-only — mirrors TraceActions.RANK_REQUIRED['sync.write']

// Built directly against the remote client, not getManifest().get('storage') —
// same reason the file-level comment gives for the remote client itself: the
// process that booted this (often the CLI) may not have registered a
// storage client at all, but the destination is always this one fixed
// cloud project regardless of what booted locally.
//
// Resolved lazily: services/supabase throws without SUPABASE_* set, and a
// local-only vessel must be able to load this module (via ACTION_REGISTRY)
// without ever touching the cloud.
let _remote = null;
function _remoteClients() {
  if (!_remote) {
    const { supabase } = require('../services/supabase');
    _remote = { supabase, storage: new StorageAdapter({ client: supabase, bucket: 'ark-media' }) };
  }
  return _remote;
}

// Filesystem-driven media cap — a sanity ceiling on what this reads into
// memory and uploads per file, not a "too big for the row" limit (that
// stopped being the constraint once uploads went to real Storage instead
// of an inline data_url; see _buildCloudMediaRow).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
};

// Verify the caller against the CLOUD's own ark_actors/role records — not
// the local session's self-declared --role. The local capability gate
// (sync.write, rank-checked from the CLI flag) still runs first via
// _assertCapability; this is a second, independent check against the
// shared, authoritative record, specific to the one action that actually
// writes into that shared record. Defense in depth, not redundancy: the
// local gate says "this session claims to be allowed," this says "the
// cloud's own records agree."
async function _verifyActor(ark_actor_id) {
  if (!ark_actor_id) {
    throw Object.assign(new Error('sync.push requires ark_actor_id — verified against the cloud ark_actors table'), { status: 400 });
  }

  const { data: actor, error: actorErr } = await _remoteClients().supabase
    .from('ark_actors')
    .select('*')
    .eq('id', ark_actor_id)
    .maybeSingle();
  if (actorErr) throw new Error(`sync.push actor lookup: ${actorErr.message}`);
  if (!actor) throw Object.assign(new Error(`Unknown ark_actor: ${ark_actor_id}`), { status: 403 });

  if (!actor.role_id) throw Object.assign(new Error(`ark_actor ${ark_actor_id} has no role assigned`), { status: 403 });

  const { data: role, error: roleErr } = await _remoteClients().supabase
    .from('artifacts')
    .select('id, metadata')
    .eq('id', actor.role_id)
    .eq('artifact_type', 'role')
    .maybeSingle();
  if (roleErr) throw new Error(`sync.push role lookup: ${roleErr.message}`);

  const rank = role?.metadata?.rank ?? -1;
  if (rank < SYNC_MIN_RANK) {
    throw Object.assign(
      new Error(`ark_actor ${ark_actor_id} rank ${rank} is below the required ${SYNC_MIN_RANK} for sync.push`),
      { status: 403, code: 'RANK_DENIED' },
    );
  }
  return actor;
}

// Resolves the Seravanna user (users.id, bigint) that pushed-but-unattributed
// artifacts get stamped with. Deliberately separate from resolveCloudActorId
// below — ark_actor is ARK's own actor identity (permission/rank, no link
// to users.id, see domain/ArkActor.js), but created_by/owner_id across the
// artifacts schema are still borrowed bigint FKs into Seravanna's real
// `users` table. Same "explicit wins, else auto-resolve the store's one
// unambiguous owner, else error" shape as resolveCloudActorId — never
// guesses across more than one ADMIN-rank user for the store.
async function resolveCloudUserId({ explicitId, store_id }) {
  if (explicitId) return explicitId;
  if (process.env.ARK_CLOUD_USER_ID) return Number(process.env.ARK_CLOUD_USER_ID);
  if (!store_id) throw Object.assign(new Error('resolveCloudUserId requires store_id when no explicit id or ARK_CLOUD_USER_ID is given'), { status: 400 });

  const { data: users, error } = await _remoteClients().supabase
    .from('users')
    .select('id, role_id, roles(rank)')
    .eq('store_id', store_id);
  if (error) throw new Error(`resolveCloudUserId lookup: ${error.message}`);

  const owners = (users || []).filter(u => (u.roles?.rank ?? -1) >= SYNC_MIN_RANK);
  if (owners.length === 1) return owners[0].id;
  if (owners.length === 0) {
    throw Object.assign(new Error(`No ADMIN-rank user found for store_id ${store_id} — pass cloud_user_id explicitly.`), { status: 400 });
  }
  throw Object.assign(
    new Error(`Multiple ADMIN-rank users for store_id ${store_id}: ${owners.map(o => o.id).join(', ')} — pass cloud_user_id explicitly.`),
    { status: 400 },
  );
}

// Resolves the cloud ark_actor_id to sync as: explicit payload value wins,
// then ARK_CLOUD_ACTOR_ID env var, then an auto-lookup of the store's
// owner-rank actor(s). Never guesses across an ambiguous result — matches
// this file's own "no implicit sync everything" stance. This does NOT
// replace _verifyActor above (which still independently re-checks whatever
// id comes out of here against the cloud's own records) — it just saves the
// caller from having to hardcode a UUID by hand every run.
async function resolveCloudActorId({ explicitId, store_id }) {
  if (explicitId) return explicitId;
  if (process.env.ARK_CLOUD_ACTOR_ID) return process.env.ARK_CLOUD_ACTOR_ID;
  if (!store_id) throw Object.assign(new Error('resolveCloudActorId requires store_id when no explicit id or ARK_CLOUD_ACTOR_ID is given'), { status: 400 });

  const { data: actors, error } = await _remoteClients().supabase
    .from('ark_actors')
    .select('id, display_name, role_id')
    .eq('store_id', store_id);
  if (error) throw new Error(`resolveCloudActorId lookup: ${error.message}`);

  const owners = [];
  for (const a of actors || []) {
    if (!a.role_id) continue;
    const { data: role } = await _remoteClients().supabase
      .from('artifacts')
      .select('metadata')
      .eq('id', a.role_id)
      .eq('artifact_type', 'role')
      .maybeSingle();
    if ((role?.metadata?.rank ?? -1) >= SYNC_MIN_RANK) owners.push(a);
  }

  if (owners.length === 1) return owners[0].id;
  if (owners.length === 0) {
    throw Object.assign(new Error(`No owner-rank ark_actor found for store_id ${store_id} — pass ark_actor_id explicitly.`), { status: 400 });
  }
  throw Object.assign(
    new Error(`Multiple owner-rank ark_actors for store_id ${store_id}: ${owners.map(o => `${o.id} (${o.display_name})`).join(', ')} — pass ark_actor_id explicitly.`),
    { status: 400 },
  );
}

// Builds the cloud artifact_media row for one local media row. Decides
// real-upload vs. cold-storage-reference: archival_master (TIFF) or
// anything over MAX_UPLOAD_BYTES becomes a resolvable-but-not-copied
// pointer — the "known but unavailable, not missing" shape from
// ark_use_case.md #5/#22/#23 — rather than an attempt to upload a 14MB+
// file. Unpaired standalone media (no representation_role at all — most
// photos never go through a JPG/TIFF pairing) is treated as uploadable,
// since there's no cold-storage counterpart to defer to. Uploads go to
// the same real Supabase Storage bucket ArtifactActions.addMedia uses —
// no more inlining bytes into the row as data_url (see
// migrate-media-to-storage.js, the one-off backfill this made permanent).
// Never throws — a missing/disconnected source file or a failed upload
// downgrades to a cold reference with the error recorded, so one bad
// file never aborts the whole sync.
async function _buildCloudMediaRow(m, { deviceLabel, dryRun }) {
  const base = {
    id:           m.id,
    artifact_id:  m.artifact_id,
    media_type:   m.media_type,
    file_size:    m.file_size,
    sort_order:   m.sort_order,
    content_hash: m.content_hash,
  };

  const role = m.metadata?.representation_role || null;
  const candidatePath = m.metadata?.archived_path || m.url;
  // representation_role depends on media.persist_pairing (an optional
  // pipeline stage) having actually written it back — confirmed live,
  // that write silently failed for some rows, and one slipped through
  // and got its raw TIFF bytes uploaded to Storage under a .jpg name
  // (undecodable — showed as a broken tile). File extension has no such
  // dependency, so it backstops the metadata check rather than replacing
  // it (a TIFF with no local path left at all still falls back on role).
  const ext = path.extname(candidatePath || '').slice(1).toLowerCase();
  const isArchivalMaster = role === 'archival_master' || ext === 'tif' || ext === 'tiff';

  if (!isArchivalMaster && candidatePath) {
    try {
      const size = m.file_size ?? fs.statSync(candidatePath).size; // stat before ever reading bytes
      if (size <= MAX_UPLOAD_BYTES) {
        const bytes = fs.readFileSync(candidatePath); // confirms the source is actually readable, real run or not
        if (dryRun) {
          return { ...base, url: null, data_url: null, metadata: { ...(m.metadata || {}), _would_upload: true } };
        }
        const ext = path.extname(candidatePath).slice(1).toLowerCase();
        const mime = EXT_MIME[ext] || m.mime_type || 'application/octet-stream';
        const data_url = `data:${mime};base64,${bytes.toString('base64')}`;
        const url = await uploadImageBytes(_remoteClients().storage, { data_url, mime_type: mime, content_hash: m.content_hash });
        return {
          ...base,
          url,
          data_url: null,
          metadata: { ...(m.metadata || {}), local_source_path: candidatePath },
        };
      }
    } catch (err) {
      return _coldReferenceRow(m, base, deviceLabel, err.message);
    }
  }

  return _coldReferenceRow(m, base, deviceLabel);
}

function _coldReferenceRow(m, base, deviceLabel, readError) {
  return {
    ...base,
    url:      null,
    data_url: null,
    metadata: {
      ...(m.metadata || {}),
      cold_storage_path:   m.metadata?.archived_path || null,
      cold_storage_status: readError ? 'source_unreadable' : (m.metadata?.archived_path ? 'known_unavailable' : 'not_yet_archived'),
      representation_role: m.metadata?.representation_role || 'unclassified',
      recorded_from_device: deviceLabel,
      recorded_at:          new Date().toISOString(),
      ...(readError ? { read_error: readError } : {}),
    },
  };
}

async function push(ctx, payload, packet) {
  const { ark_id, artifact_ids, ark_actor_id, cloud_user_id, dry_run = false, device_label } = payload;
  if (!ark_id && !artifact_ids?.length) {
    throw new Error('sync.push requires ark_id or artifact_ids[] — no implicit "sync everything"');
  }

  const actor = await _verifyActor(ark_actor_id);
  packet.log.push(`sync.push → verified ark_actor ${actor.id} "${actor.display_name}" against cloud records`);

  // Local CLI-pipeline artifacts carry no created_by (there's no Seravanna
  // user session on that path — only the ark_actor identity, which isn't
  // linked to users.id, see resolveCloudUserId above). Backfill it here, at
  // the one point where local records cross into the shared cloud store,
  // rather than leaving attribution null forever.
  const cloudUserId = await resolveCloudUserId({ explicitId: cloud_user_id, store_id: actor.store_id });

  const ids = new Set(artifact_ids || []);
  let relations = [];

  // Slugs only disambiguate automatically inside ark.create's own database
  // (see resolveSlug) — sync.push writes into a SECOND database (cloud)
  // from the local vessel, and upserts by id, so a fresh local ark with a
  // slug the cloud already has (e.g. re-running this pipeline's promote
  // step, which only checks the LOCAL vessel for an existing slug) would
  // silently create a true duplicate ark in the cloud rather than colliding
  // with anything. Checked here, the one place local records actually
  // cross into shared storage: if the cloud already has this slug under a
  // DIFFERENT id, merge into that ark instead — never sync the local ark's
  // own artifact row in that case (don't clobber whatever's already
  // curated on the real cloud ark), only add its NEW member relations,
  // remapped onto the cloud ark's id.
  let cloudArkId = null;
  if (ark_id) {
    const localArk = await Artifact.findById(ark_id, ctx);
    const slug = localArk?.get('slug');
    if (slug) {
      const { data: existingRemote, error: slugErr } = await _remoteClients().supabase
        .from('artifacts')
        .select('id')
        .eq('artifact_type', 'ark')
        .eq('slug', slug)
        .maybeSingle();
      if (slugErr) throw new Error(`sync.push cloud slug lookup: ${slugErr.message}`);
      if (existingRemote && existingRemote.id !== ark_id) {
        cloudArkId = existingRemote.id;
        packet.log.push(`sync.push → cloud already has ark slug "${slug}" (${cloudArkId}) — merging into it instead of creating a duplicate`);
      }
    }
    if (!cloudArkId) ids.add(ark_id);

    const { data: rels, error } = await Artifact.db
      .from('artifact_relations')
      .select('*')
      .eq('source_artifact_id', ark_id);
    if (error) throw new Error(error.message);

    let existingCloudTargets = new Set();
    if (cloudArkId && rels?.length) {
      const { data: existingRels, error: relErr } = await _remoteClients().supabase
        .from('artifact_relations')
        .select('target_artifact_id')
        .eq('source_artifact_id', cloudArkId)
        .in('target_artifact_id', rels.map(r => r.target_artifact_id));
      if (relErr) throw new Error(`sync.push cloud relation lookup: ${relErr.message}`);
      existingCloudTargets = new Set((existingRels || []).map(r => r.target_artifact_id));
    }

    relations = (rels || [])
      .filter(r => !existingCloudTargets.has(r.target_artifact_id))
      .map(r => cloudArkId ? { ...r, source_artifact_id: cloudArkId } : r);
    for (const r of rels || []) ids.add(r.target_artifact_id);
  }

  const artifacts = [];
  for (const id of ids) {
    const a = await Artifact.findById(id, ctx);
    if (!a) continue;
    const data = a.data;
    if (!data.created_by) data.created_by = cloudUserId;
    if (!data.owner_id)   data.owner_id   = cloudUserId;
    artifacts.push(data);
  }

  const deviceLabel = device_label || os.hostname();
  const mediaRows = [];
  for (const artifact of artifacts) {
    const { data: localMedia, error } = await ArtifactMedia.db
      .from('artifact_media')
      .select('*')
      .eq('artifact_id', artifact.id);
    if (error) throw new Error(`sync.push media lookup for ${artifact.id}: ${error.message}`);
    for (const m of localMedia || []) mediaRows.push(await _buildCloudMediaRow(m, { deviceLabel, dryRun: dry_run }));
  }
  // dry_run rows never get a real url (see _buildCloudMediaRow) — they're
  // flagged instead so the preview count still reflects what a real run
  // would do, without spending an actual upload to say so.
  const uploadedCount = mediaRows.filter(r => r.url || r.metadata?._would_upload).length;
  const coldCount      = mediaRows.length - uploadedCount;

  if (dry_run) {
    packet.log.push(`sync.push (dry run) → would sync ${artifacts.length} artifact(s), ${relations.length} relation(s), ${mediaRows.length} media (${uploadedCount} uploaded, ${coldCount} cold reference)`);
    return {
      data: {
        dry_run: true,
        merged_into_ark_id: cloudArkId,
        would_sync: {
          artifacts: artifacts.map(a => ({ id: a.id, artifact_type: a.artifact_type, title: a.title })),
          relations: relations.length,
          media: { uploaded: uploadedCount, cold_reference: coldCount },
        },
      },
    };
  }

  if (artifacts.length) {
    const { error } = await _remoteClients().supabase.from('artifacts').upsert(artifacts, { onConflict: 'id' });
    if (error) throw new Error(`sync.push artifacts: ${error.message}`);
  }
  if (relations.length) {
    const { error } = await _remoteClients().supabase.from('artifact_relations').upsert(relations, { onConflict: 'id' });
    if (error) throw new Error(`sync.push artifact_relations: ${error.message}`);
  }
  if (mediaRows.length) {
    // One upsert for all rows at once timed out live against a real 37-row
    // batch (statement timeout) — inline data_url rows run several hundred
    // KB to a few MB each, and the combined payload of a real import batch
    // is easily tens of MB in one statement. Upsert is idempotent
    // (onConflict: 'id'), so chunking is safe to retry from any point.
    const MEDIA_CHUNK_SIZE = 5;
    for (let i = 0; i < mediaRows.length; i += MEDIA_CHUNK_SIZE) {
      const chunk = mediaRows.slice(i, i + MEDIA_CHUNK_SIZE);
      const { error } = await _remoteClients().supabase.from('artifact_media').upsert(chunk, { onConflict: 'id' });
      if (error) throw new Error(`sync.push artifact_media (rows ${i + 1}-${i + chunk.length}): ${error.message}`);
    }
  }

  packet.log.push(`sync.push → synced ${artifacts.length} artifact(s), ${relations.length} relation(s), ${mediaRows.length} media (${uploadedCount} uploaded, ${coldCount} cold reference) to remote`);
  return {
    data: {
      merged_into_ark_id: cloudArkId,
      synced: { artifacts: artifacts.length, relations: relations.length, media: { uploaded: uploadedCount, cold_reference: coldCount } },
    },
  };
}

module.exports = { push, resolveCloudActorId, resolveCloudUserId };
