#!/usr/bin/env node
'use strict';

// ARK CLI — a second Gateway alongside the HTTP route (routes/action.js).
// Every command constructs a packet + ctx and calls the exact same dispatch()
// the HTTP route uses — proving the CLI has no privileged path of its own.
//
// Local mode: the db adapter defaults to a SQLite file so the whole runtime
// (Packet → PCER → ACTION_REGISTRY → ChainExecutor → Ledger) can be exercised
// with zero network dependency. Every other adapter (storage, auth, llm, ...)
// still points at the shared Supabase project for now — see Manifest.js.
//
// Every command below — including the shorthand browse commands — is a thin
// wrapper over dispatch(action, payload, ctx). None of them read the db
// directly; they exist for ergonomics, not as a second execution path.
//
// Instance data lives at ark/arks/<name>/ — each name is a complete,
// standalone runtime (its own ark.sqlite + cache/ + ark.yaml manifest),
// forkable and relocatable as a unit. `--ark <name>` selects one (default:
// "default", auto-created on first use); `--db <path>` is a raw escape
// hatch that always wins over --ark when both are given.
//
// Usage:
//   ark dispatch <action> [--payload '<json>']   generic — any ACTION_REGISTRY action
//   ark ls [artifact_type]                        artifact.list, condensed table
//   ark show <artifact_id>                        artifact.get, full JSON
//   ark arks                                      ark.list, condensed table
//   ark ledger [--limit n]                        ledger.list, condensed table
//   ark rescan [slug]                             register/update pipeline recipe(s)
//   ark status                                     vessel/owner/pipelines/media summary
//   ark fork <name> <new-name>                     copy a whole local instance, versioned
//   ark publish <pipeline_slug> <bucket>            cache bucket -> local Ark -> cloud Supabase
//   ark seed-projects                              project-base + developer template (idempotent)
//   ark serve [--port n] [--read-only]              Mission Control on 127.0.0.1 (token-gated)
//   ark cycle [--dry-run] [--lookback hours]       fire due event occurrences (system.cycle)
//
// Identity resolves one of two ways:
//   1. Explicit --user <id> --role <ADMIN|PARTNER|TECH|USER> — a Seravanna-
//      linked identity, ranks mirroring the real `roles` table.
//   2. Neither flag given — no cloud account required. Auto-provisions (or
//      reuses) a local-only ark_actor, role "owner", on this vessel. This is
//      the hiker-with-a-USB-drive case: fully governed (real capability
//      checks still run), just not tied to any Seravanna user. See
//      cli/localIdentity.js. Use --persona to set the vessel's identity
//      artifact_type on first run (default "hiker"); ignored after that.
//
// Common flags: --store <id> --user <id> --role <...> --persona <name> --ark <name> --db <path>
//
// Example:
//   ark dispatch artifact.create --user 1 --role ADMIN \
//     --payload '{"artifact_type":"note","title":"hello"}'
//   ark ls note --ark usb-sd-birds           # no --user/--role: local owner, auto-provisioned
//   ark dispatch artifact.create --persona store --payload '{...}'   # first run only

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { bootstrap } = require('../core/bootstrap');
const { ensureLocalIdentity } = require('./localIdentity');

// Every named local instance lives at <vessels root>/<name>/ — db + cache +
// a small manifest. See arks/*/ark.yaml for the "self-contained, movable,
// forkable" contract this buys. The root is outside the runtime for a
// portable install (utils/arkHome.js) and <runtime>/arks in a checkout.
const { vesselsRoot } = require('../utils/arkHome');

// Resolved when a command needs a vessel, not at load: a bad install.json
// data_root fails that command with a clear message (see main's catch)
// instead of crashing every command on require — and ark version still runs.
function arksRoot() {
  try { return vesselsRoot(); }
  catch (err) { throw Object.assign(new Error(`${err.message}. Fix data_root in install.json.`), { code: 'BAD_DATA_ROOT' }); }
}

function resolveDbPath(opts) {
  if (opts.dbPath) return opts.dbPath; // --db always wins — raw escape hatch
  return path.join(arksRoot(), opts.arkName || 'default', 'ark.sqlite');
}

// Auto-created next to a newly-provisioned ark.sqlite — records lineage/
// config, not a full portability guarantee: better-sqlite3 is a compiled
// native module, so moving this folder to another machine still needs that
// machine's own ark/ checkout + npm install, not just the data.
function _ensureArkYaml(dbPath) {
  const dir = path.dirname(dbPath);
  const yamlPath = path.join(dir, 'ark.yaml');
  if (fs.existsSync(yamlPath)) return;
  const name = path.basename(dir);
  const doc = [
    '# See ark/arks/usb-sd-birds/ark.yaml for context, or `ark fork` to create',
    "# a new versioned copy of an existing instance.",
    '',
    `name: ${name}`,
    'version: 1',
    'backend: sqlite',
    `created_at: ${new Date().toISOString()}`,
    'forked_from: null',
    'entry_point: cli/ark.js',
    '',
  ].join('\n');
  fs.writeFileSync(yamlPath, doc);
}

// Mirrors the real `roles` table (backend/services/supabase.js project).
// The CLI has no local users/roles table to verify against, so it trusts
// the operator's self-declared role — an honest limitation, not hidden.
const ROLE_RANK = { ADMIN: 100, PARTNER: 80, TECH: 60, USER: 10 };

const USAGE = [
  "Usage:",
  "  ark  (or: ark start)                          ready mode — set up on first use, then Mission Control in your browser",
  "  ark setup [--name <you>] [--yes]              walk through first-run setup (or review it)",
  "  ark cleanup-host                              remove runtimes a packed USB install unpacked on this computer",
  "  ark dispatch <action> [--payload '<json>']   generic — any ACTION_REGISTRY action",
  "  ark ls [artifact_type]                        artifact.list, condensed table",
  "  ark show <artifact_id>                        artifact.get, full JSON",
  "  ark arks                                      ark.list, condensed table",
  "  ark ledger [--limit n]                        ledger.list, condensed table",
  "  ark rescan [slug]                             register/update pipeline recipe(s)",
  "  ark status                                     vessel/owner/pipelines/media summary",
  "  ark pipeline [slug] [--path <dir>]             run a pipeline, or pick one interactively",
  "  ark cache <slug> <bucket>                      materialize a cache bucket's stubs into a media/ folder",
  "  ark fork <name> <new-name>                     copy a whole local instance, versioned",
  "  ark publish <pipeline_slug> <bucket>            cache bucket -> local Ark -> cloud Supabase",
  "               [--dry-run] [--cloud-actor <id>] [--device-label <name>]",
  "  ark seed-projects                              project-base + developer template (idempotent)",
  "  ark serve [--port n] [--read-only]              Mission Control on 127.0.0.1 (token-gated)",
  "  ark cycle [--dry-run] [--lookback hours]       fire due event occurrences (system.cycle)",
  "  ark version                                    installed runtime: version, build, install type, vessels dir",
  "  ark update --check [--source <url|dir>]        is a newer, signed release available? (read-only)",
  "  ark update / ark update --rollback             install / roll back — not in this version yet",
  "",
  "Identity: either --user <id> --role <ADMIN|PARTNER|TECH|USER>, or omit both",
  "          for an auto-provisioned local-only owner (no cloud account).",
  "Other flags: --store <id> --persona <name> --name <your name> --ark <name> --db <path>",
  "             --path <dir> --capture-year <year> --archive-root <dir>   (ark pipeline only)",
  "             --artifact-type <type>   (ark pipeline only — default 'photo', e.g. 'scene')",
].join('\n');

// Scans <vessel_dir>/cache/<pipeline_slug>/<bucket>/*.json — the disposable
// partition workspace cache.partition writes (§41's cache-as-handoff model).
// This is the *cache*, not the graph — items here may or may not have a
// durable artifact behind them yet (duplicates get a stub with no artifact_id).
// Scoped to whichever --db is active, same fix as MediaImportActions'
// _defaultCacheDir — a fixed path would show one vessel's leftovers on another.
function _gatherCachedImports(dbPath) {
  const cacheDir = path.join(path.dirname(dbPath), 'cache');
  if (!fs.existsSync(cacheDir)) return {};

  const byPipeline = {};
  for (const pipelineSlug of fs.readdirSync(cacheDir)) {
    const pipelineDir = path.join(cacheDir, pipelineSlug);
    if (!fs.statSync(pipelineDir).isDirectory()) continue;

    const buckets = {};
    for (const bucket of fs.readdirSync(pipelineDir)) {
      const bucketDir = path.join(pipelineDir, bucket);
      if (!fs.statSync(bucketDir).isDirectory()) continue;
      buckets[bucket] = fs.readdirSync(bucketDir).filter(f => f.endsWith('.json')).length;
    }
    byPipeline[pipelineSlug] = buckets;
  }
  return byPipeline;
}

// Shared by `ark status` and the first-run welcome — a plain summary, no
// personality of its own, so the welcome banner is the only place that gets
// theatrical.
async function gatherStatus(ctx, dbPath) {
  const fs   = require('fs');
  const path = require('path');
  const yaml = require('js-yaml');
  const Artifact = require('../domain/Artifact');

  const pipelines = await Artifact.query({ artifact_type: 'pipeline', limit: 100 }, ctx);

  const personasDoc = yaml.load(fs.readFileSync(path.resolve(__dirname, '../pipelines/personas.yaml'), 'utf8'));
  const infraTypes = new Set(['role', 'pipeline', 'memchart', ...Object.keys(personasDoc?.personas || {})]);

  const all = await Artifact.query({ limit: 500 }, ctx);
  const mediaCounts = {};
  for (const a of all) {
    if (infraTypes.has(a.artifact_type)) continue;
    mediaCounts[a.artifact_type] = (mediaCounts[a.artifact_type] || 0) + 1;
  }

  const cachedImports = _gatherCachedImports(dbPath);

  return { pipelines, mediaCounts, cachedImports };
}

function printStatusBlock(log, local, status) {
  const { getManifest } = require('../core/bootstrap');
  log('');
  log(`Charter: ${getManifest().get('charter_version')}`);
  log(`Vessel:  ${local.vessel?.artifact_type || 'unknown'}  ("${local.vessel?.title || 'unnamed'}")`);
  log(`Owner:   ${local.display_name}  (${local.role}, rank ${local.rank})`);
  log('');
  if (status.pipelines.length) {
    log(`Pipelines discovered (${status.pipelines.length}):`);
    for (const p of status.pipelines) log(`  ${p.slug.padEnd(16)} ${p.title}`);
  } else {
    log('Pipelines discovered: none registered yet — run "ark rescan"');
  }
  log('');
  const cachedPipelines = Object.entries(status.cachedImports);
  if (cachedPipelines.length) {
    log('Cached imports:');
    for (const [slug, buckets] of cachedPipelines) {
      const bucketSummary = Object.entries(buckets).map(([b, n]) => `${b}:${n}`).join(', ') || '(empty)';
      log(`  ${slug.padEnd(16)} ${bucketSummary}`);
    }
  } else {
    log('Cached imports: none yet');
  }
  log('');
  const mediaEntries = Object.entries(status.mediaCounts);
  if (mediaEntries.length) {
    log('Media totals:');
    for (const [type, count] of mediaEntries) log(`  ${type}: ${count}`);
  } else {
    log('Media totals: none yet');
  }
  log('');
}

async function runStatus(opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  const dbPath = resolveDbPath(opts);
  await bootLocal({ dbPath });
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const ctx = { store_id: opts.store_id, ark_actor_id: local.ark_actor_id };

  if (local.isFirstRun) {
    realLog(`Welcome, ${local.display_name}.`);
    realLog(`I've been waiting.`);
  } else {
    realLog(`Welcome back, ${local.display_name}.`);
  }

  const status = await gatherStatus(ctx, dbPath);
  printStatusBlock(realLog, local, status);
  process.exitCode = 0;
}

// Boot without the adapters' startup chatter ("⚠ LLM adapter…", "✓ Charter")
// for the friendly commands; anything that failed ("✗ …") still shows.
async function bootQuiet(args) {
  const { log, warn } = console;
  const keep = (...a) => { const s = a.join(' '); if (s.includes('✗')) console.error(s); };
  console.log = keep; console.warn = keep;
  try { return await bootLocal(args); } finally { console.log = log; console.warn = warn; }
}

async function bootLocal({ dbPath, ephemeral = false }) {
  // Reuses the exact boot path index.js calls for the HTTP server — same
  // Manifest.load(), same Packet.configure(), same schema priming — just
  // with the db adapter pointed at a local SQLite file. Ephemeral: an
  // in-memory vessel, nothing written to disk, gone when the process ends.
  if (ephemeral) return bootstrap({ db: { driver: 'sqlite', path: ':memory:' } });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true }); // better-sqlite3 won't create it
  _ensureArkYaml(dbPath);
  return bootstrap({ db: { driver: 'sqlite', path: dbPath } });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  // persona stays undefined unless given: ensureLocalIdentity defaults it
  // ('hiker'), and ark setup must tell an explicit --persona from none.
  const opts = { store_id: 1, user_id: undefined, role: undefined, persona: undefined, name: undefined, dbPath: undefined, arkName: undefined, limit: 50 };
  let payload = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--payload')      payload      = JSON.parse(rest[++i]);
    else if (arg === '--store')   opts.store_id = Number(rest[++i]);
    else if (arg === '--user')    opts.user_id  = Number(rest[++i]);
    else if (arg === '--role')    opts.role     = String(rest[++i]).toUpperCase();
    else if (arg === '--persona') opts.persona  = rest[++i];
    else if (arg === '--name')    opts.name     = rest[++i];
    else if (arg === '--db')      opts.dbPath   = rest[++i];
    else if (arg === '--ark')     opts.arkName  = rest[++i];
    else if (arg === '--limit')   opts.limit    = Number(rest[++i]);
    else if (arg === '--path')    opts.path     = rest[++i];
    else if (arg === '--capture-year') opts.captureYear = Number(rest[++i]);
    else if (arg === '--archive-root') opts.archiveRoot = rest[++i];
    else if (arg === '--artifact-type') opts.artifactType = rest[++i];
    else if (arg === '--dry-run')      opts.dryRun     = true;
    else if (arg === '--cloud-actor')  opts.cloudActor = rest[++i];
    else if (arg === '--cloud-user')   opts.cloudUser  = Number(rest[++i]);
    else if (arg === '--device-label') opts.deviceLabel = rest[++i];
    else if (arg === '--port')         opts.port       = Number(rest[++i]);
    else if (arg === '--read-only')    opts.readOnly   = true;
    else if (arg === '--lookback')     opts.lookback   = Number(rest[++i]);
    else if (arg === '--check')        opts.check      = true;
    else if (arg === '--rollback')     opts.rollback   = true;
    else if (arg === '--source')       opts.source     = rest[++i];
    else if (arg === '--yes')          opts.yes        = true;
    else if (arg === '--no-start')     opts.noStart    = true;
    else if (arg === '--no-open')      opts.noOpen     = true;
    else positional.push(arg);
  }
  return { command, positional, payload, opts };
}

// action + payload for each shorthand command, given its positional args
function resolveShorthand(command, positional, opts) {
  switch (command) {
    case 'ls':    return { action: 'artifact.list', payload: { artifact_type: positional[0], limit: opts.limit } };
    case 'show':  return { action: 'artifact.get',  payload: { artifact_id: positional[0] } };
    case 'arks':  return { action: 'ark.list',       payload: {} };
    case 'ledger':return { action: 'ledger.list',    payload: { limit: opts.limit } };
    case 'cycle': return { action: 'system.cycle',   payload: { dry_run: !!opts.dryRun, wait: true, ...(opts.lookback ? { lookback_hours: opts.lookback } : {}) } };
    case 'version': return { action: 'runtime.version', payload: {} };
    case 'update':  return opts.check ? { action: 'runtime.check', payload: {} } : null;
    default:      return null;
  }
}

// Condensed table print for list-shaped results — full JSON is one flag away
// (ark dispatch <action> --payload ...) whenever more detail is needed.
// `log` is the real stdout handle (bound before boot redirects console.log).
function printTable(log, rows, columns) {
  if (!rows.length) { log('(no results)'); return; }
  const widths = columns.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = r => columns.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ');
  log(columns.map((c, i) => c.padEnd(widths[i])).join('  '));
  log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const r of rows) log(line(r));
}

// Opens a URL in the default browser — best effort, never fatal.
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser here */ }
}

async function runServe(opts) {
  const realLog = (opts._log || console.log).bind(console);
  console.log = (...args) => console.error(...args);

  const dbPath = resolveDbPath(opts);
  if (!opts._booted) await (opts.ready ? bootQuiet : bootLocal)({ dbPath });
  const { dispatch } = require('../index');
  const { createGateway, READ_ACTIONS, DEFAULT_ACTIONS } = require('./gateway');

  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const ctx = { store_id: opts.store_id, ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank };
  const vessel = opts.dbPath ? path.basename(path.dirname(dbPath)) : (opts.arkName || 'default');

  const gw = await createGateway({
    dispatch, ctx,
    staticDir: path.resolve(__dirname, '../ui'),
    port: opts.port || 0,
    actions: opts.readOnly ? READ_ACTIONS : DEFAULT_ACTIONS,
    info: { vessel, actor: { display_name: local.display_name, role: local.role } },
  });

  // For curl/scripts. Owner-only; removed on shutdown.
  const tokenFile = path.join(path.dirname(dbPath), 'gateway.token');
  fs.writeFileSync(tokenFile, gw.token + '\n', { mode: 0o600 });

  const link = `${gw.url}/#token=${gw.token}`;
  if (opts.ready) {
    realLog(`ARK is ready, ${local.display_name}. Mission Control is open in your browser:`);
    realLog(`  ${link}`);
    realLog('');
    realLog('Keep this window open while you use ARK. Close it, or press Ctrl-C, to stop.');
  } else {
    realLog(`Mission Control — vessel "${vessel}" (${opts.readOnly ? 'read-only' : 'reads + task and event writes'})`);
    realLog(`  ${link}`);
    realLog(`  token also in ${tokenFile}`);
  }
  if (opts.open) openBrowser(link);

  // Occurrence work a Run cycle click started may still be running: finish
  // it rather than strand its claims. A second Ctrl-C stops now (those
  // claims then show as stale; they never re-run).
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
    await gw.close();
    const SystemActions = require('../actions/SystemActions');
    if (SystemActions.running()) {
      console.error(`Waiting for ${SystemActions.running()} cycle run(s) to finish — Ctrl-C again to stop now.`);
      await SystemActions.drain();
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ── ready mode: ark start / ark setup ────────────────────────────────────────
// What a double-click runs (Start ARK.command / Start ARK.cmd, or plain `ark`
// in a terminal). First use walks through setup; after that it opens Mission
// Control. This is Core's first-run walkthrough — the independent Bootstrap
// of the boundary proposal (repair a missing/broken Core) is separate.

const isTTY = () => !!(process.stdin.isTTY && process.stdout.isTTY);

function prompter() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => new Promise(res => rl.question(def ? `${q} [${def}] ` : `${q} `, a => res(a.trim() || def)));
  const yes = async (q, def = true) => { const a = await ask(`${q} (${def ? 'Y/n' : 'y/N'})`); return a ? /^y/i.test(a) : def; };
  return { ask, yes, close: () => rl.close() };
}

// payload-free: --name <you> --persona <hiker|store> --yes (no prompts) --no-start
async function runSetup(opts, { thenStart = false } = {}) {
  const out = console.log.bind(console);
  const dbPath = resolveDbPath(opts);
  const fresh = !fs.existsSync(dbPath);
  const interactive = isTTY() && !opts.yes;
  if (!interactive && !opts.yes) {
    console.error('ark setup asks a few questions — run it in a terminal, or pass --yes (with --name <you>) to accept the defaults.');
    process.exitCode = 2;
    return;
  }
  const v = require('../actions/RuntimeActions')._internals._version();
  const q = interactive ? prompter() : null;
  const personas = Object.keys(require('js-yaml').load(fs.readFileSync(path.resolve(__dirname, '../pipelines/personas.yaml'), 'utf8')).personas || {});

  out(fresh ? 'Welcome to ARK.' : 'ARK setup');
  out('');
  out(`  ARK      ${v.version} · ${v.install} install · node ${v.node}${v.node_bundled ? ' (bundled)' : ''}`);
  out(`  Your data ${path.dirname(dbPath)}`);
  out('');

  try {
    let name = opts.name;
    // --persona exactly as given; unset means ARK's default persona (the same
    // one ensureLocalIdentity uses) — never "whichever is listed first".
    const DEFAULT_PERSONA = 'hiker';
    let persona = opts.persona ?? null;
    if (fresh) {
      if (!name) name = interactive ? await q.ask('What should ARK call you?', os.userInfo().username) : os.userInfo().username;
      if (!persona && interactive && personas.length > 1) {
        const about = { hiker: 'personal — photos, memories, field notes', store: 'a business' };
        out('What is this ARK for?');
        personas.forEach((p, i) => out(`  ${i + 1}) ${about[p] || p}`));
        const pick = await q.ask('Choose', String(personas.indexOf(DEFAULT_PERSONA) + 1 || 1));
        persona = personas[Number(pick) - 1] || (personas.includes(pick) ? pick : DEFAULT_PERSONA);
      }
      persona = persona || DEFAULT_PERSONA;
      if (!personas.includes(persona)) throw new Error(`unknown persona "${persona}" — one of ${personas.join(', ')}`);
    }

    await bootQuiet({ dbPath });
    const { dispatch } = require('../index');
    const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: persona || DEFAULT_PERSONA, name });

    if (!fresh) {
      out(`  Owner    ${local.display_name}`);
      out(`  Vessel   ${path.basename(path.dirname(dbPath))}`);
      const rename = interactive ? await q.ask('Change your name? (blank keeps it)') : (opts.name && opts.name !== local.display_name ? opts.name : '');
      if (rename && rename !== local.display_name) {
        const { error } = await require('../domain/ArkActor').db.from('ark_actors').update({ display_name: rename }).eq('id', local.ark_actor_id);
        if (error) throw new Error(error.message);
        local.display_name = rename;
        out(`  Owner    ${rename}`);
      }
    } else {
      out(`  Created your vessel for ${local.display_name}.`);
    }

    // Project dashboards for Mission Control — governed writes, idempotent.
    const ctx = { store_id: opts.store_id, source: 'cli', ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank };
    const { data: tpl } = await dispatch({ action: 'template.list', payload: {} }, ctx);
    const hasProjects = (tpl?.templates || []).some(t => t.slug === 'project-base');
    if (!hasProjects && (interactive ? await q.yes('Add project dashboards to Mission Control?') : true)) {
      await require('./seedProjects').seedProjectTemplates(dispatch, ctx);
      out('  Added project dashboards.');
    }

    out('');
    out('Setup is done. Next time, just double-click "Start ARK" (or run "ark").');
    const start = thenStart || (interactive ? await q.yes('Start Mission Control now?') : false);
    if (q) q.close();
    if (start && !opts.noStart) return runServe({ ...opts, ready: true, open: !opts.noOpen, _booted: true, _log: out });
    process.exitCode = 0;
  } catch (err) {
    if (q) q.close();
    console.error(`ark setup: ${err.message}`);
    process.exitCode = 1;
  }
}

// A packed install unpacks each version on the computer it runs on
// (~/.ark/runtime/<version>-<sha>). This removes those copies — all but the
// one running now. Your data was never here: it stays on the drive.
function runCleanupHost() {
  const cache = path.resolve(process.env.ARK_RUNTIME_CACHE || path.join(os.homedir(), '.ark', 'runtime'));
  const running = fs.realpathSync(path.resolve(__dirname, '..'));
  if (!fs.existsSync(cache)) { console.log(`Nothing to clean up: ${cache} doesn't exist.`); return; }
  const removed = [];
  let kept = null;
  for (const name of fs.readdirSync(cache)) {
    const dir = path.join(cache, name);
    if (fs.realpathSync(dir) === running) { kept = name; continue; }
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(name);
  }
  console.log(removed.length ? `Removed from ${cache}: ${removed.join(', ')}` : `Nothing to remove in ${cache}.`);
  if (kept) console.log(`Kept ${kept} — it's running now. Run "ark cleanup-host" from another version (or delete ${path.join(cache, kept)} after ARK stops) to remove it.`);
}

// Ready mode: set up on first use, then Mission Control in the browser.
async function runStart(opts) {
  if (!fs.existsSync(resolveDbPath(opts))) return runSetup(opts, { thenStart: true });
  return runServe({ ...opts, ready: true, open: !opts.noOpen });
}

async function runSeedProjects(opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await bootLocal({ dbPath: resolveDbPath(opts) });
  const { dispatch } = require('../index');
  const { seedProjectTemplates } = require('./seedProjects');

  // Same local owner a normal dispatch call would get — the seed is ordinary
  // governed writes, not a privileged path.
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const ctx = { store_id: opts.store_id, source: 'cli', ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank };

  try {
    const result = await seedProjectTemplates(dispatch, ctx);
    realLog(JSON.stringify({ ok: true, ...result }, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  }
}

async function runRescan(positional, opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await bootLocal({ dbPath: resolveDbPath(opts) });
  const { ensureLocalIdentity } = require('./localIdentity');
  const { registerDirectory, registerRecipes } = require('../core/PipelineRegistry');

  // Reuses/creates the local identity so registration has a real ctx to
  // authorize against — same actor a normal dispatch call would get.
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const ctx = { store_id: opts.store_id, ark_actor_id: local.ark_actor_id, source: 'cli-rescan' };

  try {
    let results;
    if (positional[0]) {
      const dir = path.resolve(__dirname, '../pipelines', positional[0]);
      results = [await registerDirectory(dir, ctx)];
    } else {
      const pipelinesDir = path.resolve(__dirname, '../pipelines');
      const slugs = fs.readdirSync(pipelinesDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(pipelinesDir, e.name, 'pipeline.yaml')))
        .map(e => e.name);
      results = await registerRecipes(slugs, ctx, pipelinesDir);
    }
    realLog(JSON.stringify({ ok: true, registered: results.map(r => r.pipeline.slug) }, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exitCode = 1;
  }
}

function _prompt(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// `ark pipeline <slug> --path <source> [--capture-year N]`, or `ark pipeline`
// with no slug to list what's registered and select one interactively —
// same for --path if omitted. Thin wrapper over dispatch('pipeline.run'),
// same as every other shorthand in this file; not a second execution path.
async function runPipelineCommand(positional, opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  const dbPath = resolveDbPath(opts);
  await bootLocal({ dbPath });
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const ctx = { store_id: opts.store_id, ark_actor_id: local.ark_actor_id };

  if (local.isFirstRun) {
    console.error(`Welcome, ${local.display_name}.`);
    console.error(`I've been waiting.`);
    printStatusBlock(console.error, local, await gatherStatus(ctx, dbPath));
  }

  const Artifact = require('../domain/Artifact');
  const pipelines = await Artifact.query({ artifact_type: 'pipeline', limit: 100 }, ctx);

  if (!pipelines.length) {
    console.error('No pipelines registered yet — run "ark rescan" first.');
    process.exitCode = 1;
    return;
  }

  let chosen = positional[0] ? pipelines.find(p => p.slug === positional[0]) : null;

  if (!chosen && positional[0]) {
    console.error(`Pipeline not registered: "${positional[0]}" (run "ark rescan" first)\nAvailable: ${pipelines.map(p => p.slug).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (!chosen) {
    console.error('Available pipelines:');
    pipelines.forEach((p, i) => console.error(`  ${i + 1}. ${p.slug}  — ${p.title}`));
    const answer = await _prompt(`Select a pipeline (1-${pipelines.length}): `);
    chosen = pipelines[Number(answer) - 1];
    if (!chosen) {
      console.error('No valid selection made.');
      process.exitCode = 1;
      return;
    }
  }

  let sourcePath = opts.path;
  if (!sourcePath) {
    sourcePath = await _prompt(`Source path for "${chosen.slug}": `);
  }
  if (!sourcePath) {
    console.error('A source path is required (--path <dir>, or answer the prompt).');
    process.exitCode = 1;
    return;
  }

  const defaultMediaTypes = chosen.metadata?.inputs?.source_filter?.media_types || ['image', 'video', 'audio'];
  const payload = {
    pipeline_slug: chosen.slug,
    path:          sourcePath,
    media_types:   defaultMediaTypes,
    ...(opts.captureYear ? { source_metadata: { capture_year: opts.captureYear } } : {}),
    ...(opts.artifactType ? { artifact_type: opts.artifactType } : {}),
    // dest_root triggers the archive_copy stage (optional — skipped if
    // omitted, e.g. no SD card attached). source_root is the same as `path`,
    // passed through explicitly so archive_copy can mirror the camera's
    // folder structure under dest_root/ark/ rather than flattening filenames.
    ...(opts.archiveRoot ? { dest_root: opts.archiveRoot, source_root: sourcePath } : {}),
  };

  const { dispatch } = require('../index');
  try {
    const result = await dispatch(
      { action: 'pipeline.run', payload, meta: { source: 'cli' } },
      { store_id: opts.store_id, ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank, source: 'cli' },
    );
    realLog(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action: 'pipeline.run', error: { code: err.code || 'ACTION_ERROR', message: err.message } }, null, 2));
    process.exitCode = 1;
  }
}

async function runCache(positional, opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await bootLocal({ dbPath: resolveDbPath(opts) });
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const [pipeline_slug, bucket] = positional;
  if (!pipeline_slug || !bucket) {
    console.error('Usage: ark cache <pipeline_slug> <bucket>');
    process.exitCode = 1;
    return;
  }

  const { dispatch } = require('../index');
  try {
    const result = await dispatch(
      { action: 'cache.materialize_bucket', payload: { pipeline_slug, bucket }, meta: { source: 'cli' } },
      { store_id: opts.store_id, ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank, source: 'cli' },
    );
    realLog(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action: 'cache.materialize_bucket', error: { code: err.code || 'ACTION_ERROR', message: err.message } }, null, 2));
    process.exitCode = 1;
  }
}

// `ark publish <pipeline_slug> <bucket> [--dry-run] [--cloud-actor <id>]
// [--device-label <name>]` — cache (dry run) → local Ark → cloud Supabase.
// Composes two separate, auditable dispatch calls rather than one mega-
// action, so each step keeps its own capability check/ledger entry and
// cache.promote_bucket (local-only, no cloud write) always runs for real —
// only sync.push (the one step that reaches Supabase) is --dry-run-gated.
async function runPublish(positional, opts) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  await bootLocal({ dbPath: resolveDbPath(opts) });
  const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
  const [pipeline_slug, bucket] = positional;
  if (!pipeline_slug || !bucket) {
    console.error('Usage: ark publish <pipeline_slug> <bucket> [--dry-run] [--cloud-actor <id>] [--cloud-user <id>] [--device-label <name>]');
    process.exitCode = 1;
    return;
  }

  const { dispatch } = require('../index');
  const { resolveCloudActorId } = require('../actions/SyncActions');
  const ctx = { store_id: opts.store_id, ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank, source: 'cli' };

  try {
    const promoteResult = await dispatch(
      { action: 'cache.promote_bucket', payload: { pipeline_slug, bucket }, meta: { source: 'cli' } },
      ctx,
    );
    const ark = promoteResult.data.ark;

    const cloudActorId = await resolveCloudActorId({ explicitId: opts.cloudActor, store_id: opts.store_id });

    const syncResult = await dispatch(
      {
        action: 'sync.push',
        payload: {
          ark_id:        ark.id,
          ark_actor_id:  cloudActorId,
          cloud_user_id: opts.cloudUser,
          dry_run:       !!opts.dryRun,
          device_label:  opts.deviceLabel,
        },
        meta: { source: 'cli' },
      },
      ctx,
    );

    realLog(JSON.stringify({
      ok: true,
      ark:     { id: ark.id, slug: ark.slug, title: ark.title },
      promote: { added: promoteResult.data.added, already_member: promoteResult.data.already_member },
      sync:    syncResult.data,
    }, null, 2));
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, action: 'publish', error: { code: err.code || 'ACTION_ERROR', message: err.message } }, null, 2));
    process.exitCode = 1;
  }
}

// `ark fork <name> <new-name>` — copies a whole local instance directory
// (arks/<name>/) into a new one, versioned. Pure filesystem work, same as
// `rescan`'s directory-level work — no dispatch()/capability gating, since
// this doesn't touch the graph, it duplicates the vessel that holds one.
async function runFork(positional) {
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  const [name, newName] = positional;
  if (!name || !newName) {
    console.error('Usage: ark fork <name> <new-name>');
    process.exitCode = 1;
    return;
  }

  const sourceDir = path.join(arksRoot(), name);
  const destDir   = path.join(arksRoot(), newName);

  if (!fs.existsSync(sourceDir)) {
    console.error(`No ark named "${name}" at ${sourceDir}`);
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(destDir)) {
    console.error(`"${newName}" already exists at ${destDir}`);
    process.exitCode = 1;
    return;
  }

  const yaml = require('js-yaml');
  const yamlPath = path.join(sourceDir, 'ark.yaml');
  const sourceManifest = fs.existsSync(yamlPath)
    ? yaml.load(fs.readFileSync(yamlPath, 'utf8'))
    : { name, version: 1 };

  if (sourceManifest.backend === 'supabase') {
    console.error(`"${name}" is backed by Supabase, not a local vessel — nothing to fork.`);
    process.exitCode = 1;
    return;
  }

  // Best-effort WAL checkpoint before copying — a harmless leftover -wal
  // file shouldn't block a fork, but a db another process still has open
  // should: that open attempt fails loudly instead.
  const sourceDbPath = path.join(sourceDir, 'ark.sqlite');
  if (fs.existsSync(sourceDbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(sourceDbPath);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      console.error(`Could not check out "${name}"'s db before forking — is another process using it? (${err.message})`);
      process.exitCode = 1;
      return;
    }
  }

  fs.cpSync(sourceDir, destDir, { recursive: true });

  const now = new Date().toISOString();
  const newManifest = {
    ...sourceManifest,
    name: newName,
    version: (sourceManifest.version || 1) + 1,
    forked_from: { name: sourceManifest.name || name, version: sourceManifest.version || 1, forked_at: now },
    created_at: now,
  };
  fs.writeFileSync(path.join(destDir, 'ark.yaml'), yaml.dump(newManifest));

  realLog(JSON.stringify({ ok: true, forked: { from: name, to: newName, version: newManifest.version } }, null, 2));
  process.exitCode = 0;
}

async function main() {
  const { command, positional, payload: rawPayload, opts } = parseArgs(process.argv.slice(2));

  if (command === 'pipeline') {
    return runPipelineCommand(positional, opts);
  }
  if (command === 'cache') {
    return runCache(positional, opts);
  }
  if (command === 'rescan') {
    return runRescan(positional, opts);
  }
  if (command === 'status') {
    return runStatus(opts);
  }
  if (command === 'fork') {
    return runFork(positional);
  }
  if (command === 'publish') {
    return runPublish(positional, opts);
  }
  if (command === 'seed-projects') {
    return runSeedProjects(opts);
  }
  if (command === 'serve') {
    return runServe({ ...opts, open: !!opts.open });
  }
  if (command === 'cleanup-host') {
    return runCleanupHost();
  }
  if (command === 'setup') {
    return runSetup(opts);
  }
  // `ark` alone in a terminal (or a double-click) is ready mode; piped or
  // scripted, it still prints the usage.
  if (command === 'start' || (!command && isTTY())) {
    return runStart(opts);
  }

  // Installing and rolling back come with the first signed release; until
  // then say so plainly (exit 2: not an error, not done).
  if (command === 'update' && !opts.check) {
    console.error(`ark update${opts.rollback ? ' --rollback' : ''}: installing ${opts.rollback ? 'and rolling back ' : ''}updates isn't in this version yet.\n` +
      'Run "ark update --check" to see whether a newer, signed release is available.');
    process.exitCode = 2;
    return;
  }

  let action, payload;
  if (command === 'dispatch') {
    action  = positional[0];
    payload = rawPayload;
  } else {
    const shorthand = resolveShorthand(command, positional, opts);
    if (shorthand) { action = shorthand.action; payload = shorthand.payload; }
  }

  if (!action) {
    console.error(USAGE);
    process.exit(1);
  }

  // Explicit identity requires BOTH flags — one without the other is an
  // ambiguous request, not something to guess at.
  if ((opts.user_id && !opts.role) || (!opts.user_id && opts.role)) {
    console.error('--user and --role must be given together (or both omitted for a local-only identity)\n\n' + USAGE);
    process.exit(1);
  }
  if (opts.role && !(opts.role in ROLE_RANK)) {
    console.error(`Unknown role "${opts.role}" — must be one of: ${Object.keys(ROLE_RANK).join(', ')}`);
    process.exit(1);
  }

  // Boot chatter (adapter connect() logs, fire-and-forget schema priming) uses
  // raw console.log and can land at any point during the process's life — not
  // just synchronously during boot. Redirect console.log to stderr for the
  // whole run; write final output via the real stdout log directly, bypassing
  // the redirect, so stdout only ever carries the command's actual result.
  const realLog = console.log.bind(console);
  console.log = (...args) => console.error(...args);

  // Reading the runtime (version, update --check) never creates a vessel:
  // an existing one is used (its ledger records the call); otherwise the
  // same dispatch() runs against an in-memory vessel and nothing is written.
  // It needs no vessels root either, so it still runs (and reports) when
  // install.json's data_root is wrong.
  const runtimeRead = command === 'version' || (command === 'update' && opts.check);
  let dbPath = null;
  try { dbPath = resolveDbPath(opts); }
  catch (err) { if (!runtimeRead || err.code !== 'BAD_DATA_ROOT') throw err; }
  const ephemeral = runtimeRead && !opts.dbPath && (!dbPath || !fs.existsSync(dbPath));
  await bootLocal({ dbPath, ephemeral });
  const { dispatch } = require('../index');
  // --source is the local operator's choice for this process — handed to the
  // runtime directly, never through a dispatch payload.
  if (command === 'update' && opts.source) require('../actions/RuntimeActions').useSource(opts.source);

  let identityCtx;
  if (opts.user_id) {
    identityCtx = { user_id: opts.user_id, role: opts.role, rank: ROLE_RANK[opts.role] };
  } else {
    const local = await ensureLocalIdentity({ store_id: opts.store_id, persona: opts.persona, name: opts.name });
    identityCtx = { ark_actor_id: local.ark_actor_id, role: local.role, rank: local.rank };
    // To stderr, not stdout — stdout is a JSON contract for every other
    // command; the greeting is a visible side note, not part of the result.
    if (local.isFirstRun && !ephemeral) {
      console.error(`Welcome, ${local.display_name}.`);
      console.error(`I've been waiting.`);
      const status = await gatherStatus({ store_id: opts.store_id, ark_actor_id: local.ark_actor_id }, dbPath);
      printStatusBlock(console.error, local, status);
    }
  }

  try {
    const result = await dispatch(
      { action, payload, meta: { source: 'cli' } },
      {
        store_id: opts.store_id,
        source:   'cli',
        ...identityCtx,
      },
    );

    if (command === 'ls') {
      printTable(realLog, result.data.artifacts, ['id', 'artifact_type', 'title', 'status']);
    } else if (command === 'arks') {
      printTable(realLog, result.data.arks, ['id', 'title', 'status']);
    } else if (command === 'ledger') {
      printTable(realLog, result.data.ledger, ['id', 'action', 'status', 'resolution', 'opened_at']);
    } else if (command === 'version') {
      const v = result.data;
      realLog(`ark ${v.version}${v.build ? ` (${v.build})` : ''}${v.channel ? ` · ${v.channel}` : ''} · ${v.install} install`);
      if (v.install_root && path.resolve(v.runtime_dir, '..', '..') !== path.resolve(v.install_root)) realLog(`install  ${v.install_root}`);
      realLog(`runtime  ${v.runtime_dir}`);
      realLog(`vessels  ${v.vessels_dir}`);
      realLog(`host     ${v.platform} · node ${v.node}${v.node_bundled ? ' (bundled)' : ''}`);
      realLog(`updates  ${v.update_source || '(no source configured)'}`);
    } else if (command === 'update') {
      const c = result.data;
      const head = {
        available: `Update available: ${c.current} → ${c.latest?.version} (${c.latest?.channel}, released ${c.latest?.released_at?.slice(0, 10)})`,
        up_to_date: `Up to date: ${c.current}${c.latest ? ` (latest ${c.latest.version})` : ''}`,
      }[c.status] || `${c.status.replace(/_/g, ' ')}: ${c.message || ''}`;
      realLog(head);
      if (c.status === 'available' && c.latest?.notes) realLog(c.latest.notes);
      if (c.key_id) realLog(`signed by ${c.key_id}`);
      if (c.note) realLog(c.note);
    } else {
      realLog(JSON.stringify(result, null, 2));
    }
    // Not process.exit(0) — dispatch() schedules ledger.close() fire-and-forget
    // (action.js does not await it). Forcing an immediate exit here races that
    // promise and silently drops it, which is exactly why ledger entries were
    // getting stuck "open" — see LedgerActions.js fix. Setting exitCode and
    // letting Node drain naturally gives it a chance to actually finish.
    process.exitCode = 0;
  } catch (err) {
    console.error(JSON.stringify(
      { ok: false, action, error: { code: err.code || 'ACTION_ERROR', message: err.message } },
      null, 2,
    ));
    process.exitCode = 1;
  }
}

main().catch(err => {
  if (err.code !== 'BAD_DATA_ROOT') throw err;
  console.error(`ark: ${err.message}`);
  process.exitCode = 1;
});
