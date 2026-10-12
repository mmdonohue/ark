#!/usr/bin/env node
'use strict';

// ark-dev — tracks ARK's own development history using ARK itself, instead
// of flat prose appended to .claude/diary/relationship.md. See
// .claude/plans/ark/ark_dev_meta_tracking.md for the full concept.
//
// Boots against the shared Supabase project (the same adapter index.js uses
// for the real HTTP backend), NOT the disposable local SQLite vessel
// cli/ark.js defaults to — ark-dev's subject matter is inherently permanent
// and cross-machine, the opposite of what the local vessel is for. Same
// dispatch(), same ACTION_REGISTRY, same governed capability checks as every
// other entry point — no second execution path.
//
// Usage:
//   ark-dev init                                    idempotent: create the
//                                                    ark-dev Ark, upsert its
//                                                    memchart, ingest the
//                                                    Charter (new version
//                                                    only if content changed)
//   ark-dev log --title <t> [--summary <s>] [--body <text>|--body-file <path>]
//                                                    record a session_log
//                                                    artifact into ark-dev
//   ark-dev show                                     continuity view: Charter
//                                                    version, memchart, and
//                                                    session_log entries
//                                                    (most recent first)
//   ark-dev dispatch <action> [--payload '<json>']   generic — any action

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const { bootstrap } = require('../core/bootstrap');
const { ensureLocalIdentity } = require('./localIdentity');
const Artifact = require('../domain/Artifact');

const CHARTER_PATH  = path.resolve(__dirname, '../CHARTER.md');
const MEMCHART_PATH = path.resolve(__dirname, '../pipelines/ark-dev/memchart.yaml');
const ARK_SLUG      = 'ark-development'; // derived by ark.create from the title "ARK Development"
const CHARTER_SLUG  = 'ark-architecture-charter';
const MANIFEST_PATH = path.resolve(__dirname, '../arks/ark-dev/ark.yaml');

const USAGE = [
  'Usage:',
  "  ark-dev init                                    idempotent setup (ark, memchart, charter)",
  "  ark-dev log --title <t> [--summary <s>] [--body <text>|--body-file <path>]",
  "                                                    chronological narrative (session_log)",
  "  ark-dev decision --title <t> [--summary <s>] [--body <text>|--body-file <path>]",
  "                                                    a settled, owner-approved choice (decision)",
  "  ark-dev hard-won --title <t> [--summary <s>] [--body <text>|--body-file <path>]",
  "                                                    institutional scar tissue — why an invariant exists (hard_won)",
  "  ark-dev unresolved --title <t> [--summary <s>] [--body <text>|--body-file <path>]",
  "                                                    a genuinely open question (unresolved_question)",
  "  ark-dev show                                     continuity view",
  "  ark-dev dispatch <action> [--payload '<json>']   generic — any action",
  '',
  'See .claude/plans/ark/arkdev_agent_context.md §3 for what belongs in each type.',
].join('\n');

// artifact_type per CLI command — the four durable record types this file
// writes into ark-dev. session_log stays the default/existing behavior;
// decision/hard_won/unresolved_question are the new ones per
// arkdev_agent_context.md §3's RESOLVED/DISCOVERED/UNRESOLVED contract
// (ACCEPTANCE isn't a standalone record type — it's evidence attached to a
// decision or session, not tracked separately here yet).
const RECORD_TYPES = {
  log:        'session_log',
  decision:   'decision',
  'hard-won': 'hard_won',
  unresolved: 'unresolved_question',
};

// No db.driver override → Manifest.load() takes the Postgres/Supabase branch.
// Deliberate exception to ark/'s "no reach outside its own tree" rule: ark-dev
// is the one instance pinned to Seravanna's shared cloud project by design
// (see arks/ark-dev/ark.yaml, backend: supabase) — not a portable standalone
// vessel, so it's fine for it alone to import Seravanna's own db client.
async function boot() {
  const { supabase } = require('../services/supabase');
  return bootstrap({ db: { client: supabase } });
}

function _ensureArkDevManifest() {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  if (fs.existsSync(MANIFEST_PATH)) return;
  const doc = [
    '# See backend/ark/arks/usb-sd-birds/ark.yaml for the general manifest shape.',
    '# ark-dev is the one deliberate exception: pinned to Seravanna\'s shared',
    '# Supabase project, not a portable/forkable standalone vessel — no local',
    '# db/cache here by design.',
    '',
    'name: ark-dev',
    'version: 1',
    'backend: supabase',
    `created_at: ${new Date().toISOString()}`,
    'forked_from: null',
    'entry_point: cli/ark-dev.js',
    '',
  ].join('\n');
  fs.writeFileSync(MANIFEST_PATH, doc);
}

async function identity() {
  // Reuses Matt's existing ark_actor in the shared project (store_id 1 —
  // Seravanna, the only tenant so far) rather than provisioning a new one.
  const local = await ensureLocalIdentity({ store_id: 1 });
  return { store_id: 1, ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank, source: 'cli' };
}

function _readYaml(p) { return yaml.load(fs.readFileSync(p, 'utf8')); }
function _sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function _findArkDev(ctx) {
  const [found] = await Artifact.query({ artifact_type: 'ark', filters: [['slug', 'eq', ARK_SLUG]] }, ctx);
  return found || null;
}

async function _ensureArkDev(ctx, dispatch) {
  const existing = await _findArkDev(ctx);
  if (existing) return existing;

  const result = await dispatch(
    { action: 'ark.create', payload: { title: 'ARK Development', summary: 'Tracks ARK\'s own development history — using ARK itself, not diary prose.' }, meta: { source: 'cli' } },
    ctx,
  );
  return result.data.ark;
}

async function _ensureMemchart(ctx, arkDevId, dispatch) {
  const doc = _readYaml(MEMCHART_PATH);
  const [existing] = await Artifact.query({ artifact_type: 'memchart', filters: [['slug', 'eq', doc.slug]] }, ctx);

  let memchart;
  if (existing) {
    memchart = existing;
    // Keep content current if memchart.yaml changed since last init.
    const artifact = new Artifact({ id: existing.id }, { context: ctx });
    artifact.assign({ metadata: doc, title: doc.title || doc.slug });
    await artifact.save();
  } else {
    const artifact = new Artifact({
      artifact_type: 'memchart',
      title:  doc.title || doc.slug,
      slug:   doc.slug,
      status: 'published',
      metadata: doc,
      context: { visibility: 'private' },
    }, { context: ctx });
    await artifact.save();
    memchart = artifact.data;
  }

  const { data: rels } = await Artifact.db
    .from('artifact_relations')
    .select('id')
    .eq('source_artifact_id', arkDevId)
    .eq('target_artifact_id', memchart.id)
    .eq('relation_type', 'contains');

  if (!rels?.length) {
    await dispatch({ action: 'ark.add_artifact', payload: { ark_id: arkDevId, artifact_id: memchart.id }, meta: { source: 'cli' } }, ctx);
  }

  return memchart;
}

// Charter is versioned by content hash, not overwritten in place — an
// amendment (Charter file changed since last ingest) creates a NEW artifact
// version with a `supersedes` relation back to the prior one, so history is
// real provenance, not a diff nobody can see.
async function _ensureCharter(ctx, arkDevId, dispatch) {
  const source = fs.readFileSync(CHARTER_PATH, 'utf8');
  const sourceHash = _sha256(source);

  const versions = await Artifact.query(
    { artifact_type: 'charter', filters: [['slug', 'eq', CHARTER_SLUG]], limit: 100, order: { column: 'created_at', ascending: false } },
    ctx,
  );
  const latest = versions[0] || null;

  if (latest?.metadata?.source_hash === sourceHash) {
    return { charter: latest, changed: false };
  }

  const nextVersion = (latest?.metadata?.version || 0) + 1;
  const result = await dispatch(
    {
      action: 'artifact.create',
      payload: {
        artifact_type: 'charter',
        title: `ARK Architecture Charter v${nextVersion}`,
        slug: CHARTER_SLUG,
        body: source,
        status: 'published',
        metadata: { version: nextVersion, source_hash: sourceHash, source_file: 'backend/ark/CHARTER.md' },
        ark_id: arkDevId,
      },
      meta: { source: 'cli' },
    },
    ctx,
  );
  const charter = result.data.artifact;

  if (latest) {
    await dispatch(
      { action: 'artifact.relate', payload: { source_id: charter.id, target_id: latest.id, relation_type: 'supersedes' }, meta: { source: 'cli' } },
      ctx,
    );
  }

  return { charter, changed: true };
}

// Pipelines aren't a single file — a pipeline.yaml commonly references
// sibling rule files, prompts, provider configs (see e.g.
// usb-sd-birds/rules/*.yaml). Versioning by content_hash of just the entry
// file would miss changes to those — instead this hashes the whole
// directory (every file under it, sorted by path) into one combined hash,
// so editing a rule file triggers a new pipeline version even though
// pipeline.yaml itself didn't change. Same create-a-new-version +
// supersedes pattern as _ensureCharter, just discovering N directories
// instead of one fixed file.
const PIPELINES_ROOT = path.resolve(__dirname, '../pipelines');

function _walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(..._walkFiles(full));
    else out.push(full);
  }
  return out;
}

function _discoverPipelineDirs() {
  const dirs = [];
  for (const entry of fs.readdirSync(PIPELINES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryFile = path.join(PIPELINES_ROOT, entry.name, 'pipeline.yaml');
    if (fs.existsSync(entryFile)) dirs.push({ name: entry.name, dir: path.join(PIPELINES_ROOT, entry.name), entryFile });
  }
  return dirs;
}

async function _ensurePipeline(ctx, arkDevId, dispatch, { name, dir, entryFile }) {
  const entryYaml = _readYaml(entryFile);
  const slug = entryYaml.slug || name;

  const componentFiles = _walkFiles(dir)
    .map(f => ({ path: path.relative(PIPELINES_ROOT, f), hash: _sha256(fs.readFileSync(f, 'utf8')) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const combinedHash = _sha256(componentFiles.map(f => `${f.path}:${f.hash}`).join('\n'));

  const versions = await Artifact.query(
    { artifact_type: 'pipeline', filters: [['slug', 'eq', slug]], limit: 100, order: { column: 'created_at', ascending: false } },
    ctx,
  );
  const latest = versions[0] || null;

  if (latest?.metadata?.combined_hash === combinedHash) {
    return { pipeline: latest, changed: false };
  }

  const nextVersion = (latest?.metadata?.version || 0) + 1;
  const title = name.split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const result = await dispatch(
    {
      action: 'artifact.create',
      payload: {
        artifact_type: 'pipeline',
        title: `${title}${nextVersion > 1 ? ` v${nextVersion}` : ''}`,
        slug,
        summary: entryYaml.intent ? String(entryYaml.intent).trim() : null,
        body: fs.readFileSync(entryFile, 'utf8'),
        status: 'published',
        metadata: {
          version: nextVersion,
          combined_hash: combinedHash,
          source_dir: path.relative(path.resolve(__dirname, '../../..'), dir),
          component_files: componentFiles,
        },
        ark_id: arkDevId,
      },
      meta: { source: 'cli' },
    },
    ctx,
  );
  const pipeline = result.data.artifact;

  if (latest) {
    await dispatch(
      { action: 'artifact.relate', payload: { source_id: pipeline.id, target_id: latest.id, relation_type: 'supersedes' }, meta: { source: 'cli' } },
      ctx,
    );
  }

  return { pipeline, changed: true };
}

async function _ensurePipelines(ctx, arkDevId, dispatch) {
  const results = [];
  for (const p of _discoverPipelineDirs()) {
    results.push({ name: p.name, ...(await _ensurePipeline(ctx, arkDevId, dispatch, p)) });
  }
  return results;
}

// Skills — durable, hard-won technical knowledge. Distinct from
// session_log (chronological narrative) and from Professor's future
// ark-learning-path content (curated/pedagogical, the opposite direction —
// authored to teach rather than earned through doing). Same content-hash +
// supersedes versioning as Charter/pipelines: seed content lives in
// seedSkills.js, re-running init is a no-op unless a skill's content
// actually changed.
const { SKILLS } = require('./seedSkills');

async function _ensureSkill(ctx, arkDevId, dispatch, skill) {
  const contentHash = _sha256(JSON.stringify({
    title: skill.title, summary: skill.summary, body: skill.body,
    tags: skill.tags, applies_to: skill.applies_to,
    confidence: skill.confidence, source_type: skill.source_type,
  }));

  const versions = await Artifact.query(
    { artifact_type: 'skill', filters: [['slug', 'eq', skill.slug]], limit: 100, order: { column: 'created_at', ascending: false } },
    ctx,
  );
  const latest = versions[0] || null;

  if (latest?.metadata?.content_hash === contentHash) {
    return { skill: latest, changed: false };
  }

  const nextVersion = (latest?.metadata?.version || 0) + 1;
  const result = await dispatch(
    {
      action: 'artifact.create',
      payload: {
        artifact_type: 'skill',
        title: skill.title,
        slug: skill.slug,
        summary: skill.summary,
        body: skill.body,
        status: 'published',
        metadata: {
          version: nextVersion,
          content_hash: contentHash,
          tags: skill.tags,
          applies_to: skill.applies_to,
          confidence: skill.confidence,
          source_type: skill.source_type,
        },
        ark_id: arkDevId,
      },
      meta: { source: 'cli' },
    },
    ctx,
  );
  const created = result.data.artifact;

  if (latest) {
    await dispatch(
      { action: 'artifact.relate', payload: { source_id: created.id, target_id: latest.id, relation_type: 'supersedes' }, meta: { source: 'cli' } },
      ctx,
    );
  }

  return { skill: created, changed: true };
}

async function _ensureSkills(ctx, arkDevId, dispatch) {
  const results = [];
  for (const s of SKILLS) {
    results.push({ slug: s.slug, ...(await _ensureSkill(ctx, arkDevId, dispatch, s)) });
  }
  return results;
}

async function runInit() {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await boot();
  const { dispatch } = require('../index');
  const ctx = await identity();

  _ensureArkDevManifest();
  const arkDev = await _ensureArkDev(ctx, dispatch);
  const memchart = await _ensureMemchart(ctx, arkDev.id, dispatch);
  const { charter, changed } = await _ensureCharter(ctx, arkDev.id, dispatch);
  const pipelines = await _ensurePipelines(ctx, arkDev.id, dispatch);
  const skills = await _ensureSkills(ctx, arkDev.id, dispatch);

  realLog(JSON.stringify({
    ok: true,
    ark_dev: { id: arkDev.id, slug: arkDev.slug },
    memchart: { id: memchart.id, slug: memchart.slug },
    charter: { id: charter.id, version: charter.metadata?.version, changed },
    pipelines: pipelines.map(p => ({ name: p.name, id: p.pipeline.id, version: p.pipeline.metadata?.version, changed: p.changed })),
    skills: skills.map(s => ({ slug: s.slug, id: s.skill.id, version: s.skill.metadata?.version, changed: s.changed })),
  }, null, 2));
  process.exitCode = 0;
}

// Shared by all four record commands (log/decision/hard-won/unresolved) —
// same title/summary/body(-file) shape, only the artifact_type and the
// output's top-level key differ. session_log's own metadata.date is kept
// as-is (existing behavior, existing consumers in runShow below); the other
// three types don't get a date field since they aren't chronological
// entries in the same sense — a decision/hard_won/unresolved_question is
// keyed by its content, not by when it was logged.
async function runRecord(artifactType, opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await boot();
  const { dispatch } = require('../index');
  const ctx = await identity();

  const arkDev = await _findArkDev(ctx);
  if (!arkDev) {
    console.error('ark-dev not initialized yet — run "ark-dev init" first.');
    process.exitCode = 1;
    return;
  }

  if (!opts.title) {
    console.error('--title is required\n\n' + USAGE);
    process.exitCode = 1;
    return;
  }

  const body = opts.bodyFile ? fs.readFileSync(opts.bodyFile, 'utf8') : (opts.body || null);

  const result = await dispatch(
    {
      action: 'artifact.create',
      payload: {
        artifact_type: artifactType,
        title: opts.title,
        summary: opts.summary || null,
        body,
        status: 'published',
        metadata: artifactType === 'session_log' ? { date: new Date().toISOString().slice(0, 10) } : {},
        ark_id: arkDev.id,
      },
      meta: { source: 'cli' },
    },
    ctx,
  );

  realLog(JSON.stringify({ ok: true, [artifactType]: result.data.artifact }, null, 2));
  process.exitCode = 0;
}

async function runShow() {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await boot();
  const { dispatch } = require('../index');
  const ctx = await identity();

  const arkDev = await _findArkDev(ctx);
  if (!arkDev) {
    console.error('ark-dev not initialized yet — run "ark-dev init" first.');
    process.exitCode = 1;
    return;
  }

  const result = await dispatch({ action: 'ark.get', payload: { ark_id: arkDev.id }, meta: { source: 'cli' } }, ctx);
  const { artifacts } = result.data;

  const charter = artifacts.filter(a => a.artifact_type === 'charter').sort((a, b) => (b.metadata?.version || 0) - (a.metadata?.version || 0))[0];
  const memchart = artifacts.find(a => a.artifact_type === 'memchart');
  const sessionLogs = artifacts.filter(a => a.artifact_type === 'session_log'); // order_index desc → most recent first
  const decisions   = artifacts.filter(a => a.artifact_type === 'decision');
  const hardWons     = artifacts.filter(a => a.artifact_type === 'hard_won');
  const unresolved   = artifacts.filter(a => a.artifact_type === 'unresolved_question');

  realLog('');
  realLog(`ark-dev  (${arkDev.id})`);
  realLog('');
  if (charter) realLog(`Charter: v${charter.metadata?.version}  "${charter.title}"`);
  if (memchart) realLog(`Memchart values: ${(memchart.metadata?.memory?.value || []).join(', ')}`);
  realLog('');

  // Settled decisions and scar tissue surface ahead of the chronological
  // log — per arkdev_agent_context.md, RESOLVED/Hard Won context is what a
  // fresh agent needs BEFORE reading "what happened when," not after.
  if (decisions.length) {
    realLog(`Decisions (${decisions.length}):`);
    for (const d of decisions) realLog(`  ${d.title}${d.summary ? ` — ${d.summary}` : ''}`);
    realLog('');
  }
  if (hardWons.length) {
    realLog(`Hard Wons (${hardWons.length}):`);
    for (const h of hardWons) realLog(`  ${h.title}${h.summary ? ` — ${h.summary}` : ''}`);
    realLog('');
  }
  if (unresolved.length) {
    realLog(`Unresolved (${unresolved.length}):`);
    for (const u of unresolved) realLog(`  ${u.title}${u.summary ? ` — ${u.summary}` : ''}`);
    realLog('');
  }

  if (sessionLogs.length) {
    realLog(`Session log (${sessionLogs.length}, most recent first):`);
    for (const s of sessionLogs) realLog(`  ${s.metadata?.date || ''}  ${s.title}${s.summary ? ` — ${s.summary}` : ''}`);
  } else {
    realLog('Session log: none yet — run "ark-dev log --title ..."');
  }
  realLog('');
  process.exitCode = 0;
}

async function runDispatch(positional, payload) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  const action = positional[0];
  if (!action) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  await boot();
  const { dispatch } = require('../index');
  const ctx = await identity();

  try {
    const result = await dispatch({ action, payload, meta: { source: 'cli' } }, ctx);
    realLog(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action, error: { code: err.code || 'ACTION_ERROR', message: err.message } }, null, 2));
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  let payload = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--payload')    payload        = JSON.parse(rest[++i]);
    else if (arg === '--title')    opts.title     = rest[++i];
    else if (arg === '--summary')  opts.summary   = rest[++i];
    else if (arg === '--body')     opts.body      = rest[++i];
    else if (arg === '--body-file') opts.bodyFile = rest[++i];
    else positional.push(arg);
  }
  return { command, positional, payload, opts };
}

async function main() {
  const { command, positional, payload, opts } = parseArgs(process.argv.slice(2));

  if (command === 'init')     return runInit();
  if (command === 'show')     return runShow();
  if (command === 'dispatch') return runDispatch(positional, payload);
  if (RECORD_TYPES[command])  return runRecord(RECORD_TYPES[command], opts);

  console.error(USAGE);
  process.exitCode = 1;
}

main();
