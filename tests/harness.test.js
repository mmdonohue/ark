'use strict';

// Harness adapter + snapshot tests. No network, no DB, no real agent CLI:
// drivers point at small node scripts that impersonate `claude`/`copilot`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HarnessAdapter = require('../adapters/harness');
const { HarnessError, _internals: H } = HarnessAdapter;
const snapshot = require('../utils/snapshot');
const drift = require('../utils/drift');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-harness-test-'));

// A fake CLI: answers --version, then runs `body` (JS) with stdin in `input`.
function fakeCli(name, body, { version = `${name} 1.0.0` } = {}) {
  const file = path.join(TMP, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    `if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }`,
    'let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {',
    body,
    '});',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

const claudeOk = (result = 'claude report') => fakeCli('claude', `
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(result)},
    total_cost_usd: 0.5, num_turns: 3, modelUsage: { 'claude-opus-5-5': {} }, permission_denials: [{ tool_name: 'Edit' }] }));
`);
const claudeRateLimited = (reset = '') => fakeCli('claude', `
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
    result: 'Claude AI usage limit reached${reset}' }));
  process.exit(1);
`);
// Emits the JSONL event stream Copilot CLI 1.0.106 produces with --output-format json.
const copilotEvents = (contentExpr) => `
  const ev = (type, data) => console.log(JSON.stringify({ type, data }));
  ev('session.tools_updated', { model: 'claude-sonnet-5.5' });
  ev('assistant.message', { content: '', toolRequests: [{ name: 'view' }] });
  ev('assistant.message', { content: ${contentExpr} });
  console.log(JSON.stringify({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } }));
`;
const copilotOk = () => fakeCli('copilot', copilotEvents("'copilot report: ' + input"));

function adapter(drivers, extra = {}) {
  return new HarnessAdapter({ drivers, failover: true, allowed_roots: [TMP], ...extra });
}
const req = (extra = {}) => ({ prompt: 'review it', cwd: TMP, required_capabilities: ['repo.read'], ...extra });

// ── Output parsing ───────────────────────────────────────────────────────────

test('claude-code parse: success maps report, model, cost, denials', () => {
  const r = H.KINDS['claude-code'].parse({ stdout: JSON.stringify({ subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.1, modelUsage: { m1: {} }, permission_denials: [{ tool_name: 'Write' }] }), stderr: '', exitCode: 0 });
  assert.deepEqual([r.ok, r.report, r.model, r.cost_usd, r.denials], [true, 'ok', 'm1', 0.1, ['Write']]);
});

test('claude-code parse: 429, budget, auth and non-JSON output are classified', () => {
  const P = o => H.KINDS['claude-code'].parse({ stdout: JSON.stringify(o), stderr: '', exitCode: 1 });
  assert.equal(P({ is_error: true, api_error_status: 429, result: 'limit|1999999999' }).code, 'RATE_LIMITED');
  assert.equal(P({ is_error: true, api_error_status: 429, result: 'limit|1999999999' }).retry_at, 1999999999000);
  assert.equal(P({ is_error: true, subtype: 'error_max_budget_usd' }).code, 'BUDGET_EXCEEDED');
  assert.equal(P({ is_error: true, api_error_status: 401, result: 'bad key' }).code, 'AUTH_FAILED');
  assert.equal(H.KINDS['claude-code'].parse({ stdout: '', stderr: "You've hit your limit", exitCode: 1 }).code, 'RATE_LIMITED');
  assert.equal(H.KINDS['claude-code'].parse({ stdout: 'boom', stderr: '', exitCode: 2 }).code, 'PROVIDER_ERROR');
});

test('claude-code build: read-only tools, no prompt in argv, budget passed through', () => {
  const { args, stdin } = H.KINDS['claude-code'].build({ prompt: 'secret-ish prompt' }, { limits: { max_budget_usd: 2 } });
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '2');
  assert.ok(!args.includes('secret-ish prompt'));
  assert.equal(stdin, 'secret-ish prompt');
});

test('copilot build: read-only tool surface, prompt on stdin, no self-update', () => {
  const { args, stdin } = H.KINDS.copilot.build({ prompt: 'p' }, { limits: { max_ai_credits: 60 } });
  assert.ok(args.includes('--available-tools=view,grep,glob'));
  for (const a of ['--deny-tool=write', '--deny-tool=shell', '--disable-builtin-mcps', '--no-auto-update']) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf('--max-ai-credits') + 1], '60');
  assert.ok(!args.includes('-p') && !args.includes('p'));
  assert.equal(stdin, 'p');
});

test('copilot parse: report, requests and failures', () => {
  const P = (lines, exitCode = 0, stderr = '') => H.KINDS.copilot.parse({ stdout: lines.map(l => JSON.stringify(l)).join('\n'), stderr, exitCode });
  const ok = P([{ type: 'assistant.message', data: { content: 'draft' } }, { type: 'assistant.message', data: { content: 'final' } },
    { type: 'tool.execution_complete', data: { toolName: 'view', success: false } }, { type: 'result', exitCode: 0, usage: { premiumRequests: 2 } }]);
  assert.deepEqual([ok.ok, ok.report, ok.requests, ok.denials], [true, 'final', 2, ['view']]);
  assert.equal(P([{ type: 'result', exitCode: 0 }]).code, 'PROVIDER_ERROR', 'exit 0 with no report is not a success');
  assert.equal(P([{ type: 'session.error', data: { message: 'Session limits reached: 60/60 AI credits used' } }, { type: 'result', exitCode: 1 }], 1).code, 'BUDGET_EXCEEDED');
  assert.equal(P([{ type: 'session.error', data: { message: 'You have exceeded your premium requests quota' } }, { type: 'result', exitCode: 1 }], 1).code, 'RATE_LIMITED');
  assert.equal(P([], 1, 'Error: Not logged in. Run copilot login').code, 'AUTH_FAILED');
});

test('premium requests/day limit blocks copilot pre-flight', async () => {
  const h = adapter([{ name: 'copilot', kind: 'copilot', bin: copilotOk(), limits: { max_requests_per_day: 1 } }]);
  assert.equal((await h.run(req())).attempts[0].requests, 1);
  await assert.rejects(h.run(req()), e => e.code === 'LIMIT_REACHED' && /premium requests/.test(e.message));
});

// ── Failover and limits ──────────────────────────────────────────────────────

test('rate-limited claude fails over to copilot; both attempts are reported', async () => {
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: claudeRateLimited() }, { name: 'copilot', kind: 'copilot', bin: copilotOk() }]);
  const r = await h.run(req());
  assert.equal(r.driver, 'copilot');
  assert.equal(r.report, 'copilot report: review it', 'prompt arrives on stdin, report is the last assistant message');
  assert.equal(r.model, 'claude-sonnet-5.5');
  assert.deepEqual(r.attempts.map(a => [a.driver, a.code]), [['claude', 'RATE_LIMITED'], ['copilot', null]]);
});

test('a provider cooldown is honoured pre-flight: claude is not spawned again', async () => {
  const marker = path.join(TMP, `spawned-${Date.now()}`);
  const claude = fakeCli('claude', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log(JSON.stringify({ is_error: true, api_error_status: 429, result: 'usage limit reached' })); process.exit(1);`);
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: claude }, { name: 'copilot', kind: 'copilot', bin: copilotOk() }]);
  await h.run(req());
  fs.rmSync(marker);
  const r = await h.run(req());
  assert.equal(r.driver, 'copilot');
  assert.equal(fs.existsSync(marker), false, 'claude must not be spawned while cooling down');
  assert.match(r.attempts[0].message, /cooling down until/);
  const [claudeDesc] = await h.describe();
  assert.equal(claudeDesc.available, false);
  assert.ok(claudeDesc.cooldown_until);
});

test('reset time from the provider sets the cooldown end', async () => {
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: claudeRateLimited(`|${resetSec}`) }]);
  await assert.rejects(h.run(req()), e => e.code === 'RATE_LIMITED');
  const [d] = await h.describe();
  assert.equal(d.cooldown_until, new Date(resetSec * 1000).toISOString());
});

test('our own limits: runs/day and USD/day block pre-flight and fail over', async () => {
  const h = adapter([
    { name: 'claude', kind: 'claude-code', bin: claudeOk(), limits: { max_runs_per_day: 1 } },
    { name: 'copilot', kind: 'copilot', bin: copilotOk() },
  ]);
  assert.equal((await h.run(req())).driver, 'claude');
  const r = await h.run(req());
  assert.equal(r.driver, 'copilot');
  assert.equal(r.attempts[0].code, 'LIMIT_REACHED');

  const spend = adapter([{ name: 'claude', kind: 'claude-code', bin: claudeOk(), limits: { max_usd_per_day: 0.4 } }]);
  await spend.run(req()); // fake reports $0.50
  await assert.rejects(spend.run(req()), e => e.code === 'LIMIT_REACHED' && /\$0\.50\/\$0\.4/.test(e.message));
});

test('usage and cooldowns persist across adapter instances via the state file', async () => {
  const cfg = path.join(TMP, `harness-${Date.now()}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ allowed_roots: [TMP], drivers: [{ name: 'claude', kind: 'claude-code', bin: claudeOk(), limits: { max_runs_per_day: 1 } }] }));
  const prev = process.env.ARK_HARNESS_CONFIG;
  process.env.ARK_HARNESS_CONFIG = cfg;
  try {
    await new HarnessAdapter().run(req());
    await assert.rejects(new HarnessAdapter().run(req()), e => e.code === 'LIMIT_REACHED');
    assert.ok(fs.existsSync(cfg.replace(/\.json$/, '.state.json')));
  } finally {
    if (prev == null) delete process.env.ARK_HARNESS_CONFIG; else process.env.ARK_HARNESS_CONFIG = prev;
  }
});

test('failover:false stops at the first failure', async () => {
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: claudeRateLimited() }, { name: 'copilot', kind: 'copilot', bin: copilotOk() }]);
  await assert.rejects(h.run(req({ failover: false })), e => e instanceof HarnessError && e.code === 'RATE_LIMITED' && e.attempts.length === 1);
});

test('missing binary and a "not found" shim are unavailable, and fail over', async () => {
  const shim = fakeCli('copilot', 'process.exit(0)', { version: 'GitHub Copilot CLI was not found. Run copilot to install it' });
  const h = adapter([
    { name: 'ghost', kind: 'claude-code', bin: path.join(TMP, 'does-not-exist') },
    { name: 'shim', kind: 'copilot', bin: shim },
    { name: 'claude', kind: 'claude-code', bin: claudeOk() },
  ]);
  const r = await h.run(req());
  assert.equal(r.driver, 'claude');
  assert.deepEqual(r.attempts.map(a => a.code), ['HARNESS_UNAVAILABLE', 'HARNESS_UNAVAILABLE', null]);
  assert.deepEqual(await h.capabilities(), ['repo.read', 'code.review', 'report.write', 'artifact.read', 'ledger.read', 'task.propose']);
});

test('no drivers configured: every capability is unavailable', async () => {
  const h = new HarnessAdapter({ drivers: [] });
  assert.deepEqual(await h.capabilities(), []);
  await assert.rejects(h.run(req()), e => e.code === 'CAPABILITY_MISSING');
});

test('a capability no driver offers is CAPABILITY_MISSING, nothing spawned', async () => {
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: claudeOk() }]);
  await assert.rejects(h.run(req({ required_capabilities: ['repo.write'] })), e => e.code === 'CAPABILITY_MISSING');
});

test('timeout is terminal (no failover) and kills the process', async () => {
  const hang = fakeCli('claude', 'setInterval(() => {}, 1000);');
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: hang, limits: { timeout_ms: 300 } }, { name: 'copilot', kind: 'copilot', bin: copilotOk() }]);
  await assert.rejects(h.run(req()), e => e.code === 'TIMEOUT' && e.attempts.length === 1);
});

test('cancel stops a running attempt', async () => {
  const hang = fakeCli('claude', 'setInterval(() => {}, 1000);');
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: hang }]);
  const p = h.run(req({ run_key: 'k1' }));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(h.cancel('k1'), true);
  await assert.rejects(p, e => e.code === 'CANCELLED');
  assert.equal(h.cancel('k1'), false);
});

test('the harness process does not inherit backend secrets', async () => {
  process.env.SUPABASE_SERVICE_KEY_TEST = 'leak-me';
  const env = fakeCli('copilot', copilotEvents('JSON.stringify(Object.keys(process.env))'));
  const h = adapter([{ name: 'copilot', kind: 'copilot', bin: env }]);
  const keys = JSON.parse((await h.run(req())).report);
  delete process.env.SUPABASE_SERVICE_KEY_TEST;
  assert.ok(!keys.includes('SUPABASE_SERVICE_KEY_TEST'));
  assert.ok(keys.includes('PATH'));
});

test('allowed_roots: paths outside are refused, symlink escapes resolved', () => {
  const h = adapter([]);
  assert.equal(h.isAllowedPath(TMP), true);
  assert.equal(h.isAllowedPath(path.join(TMP, 'x', '..')), true);
  assert.equal(h.isAllowedPath(os.homedir()), false);
  const link = path.join(TMP, 'escape');
  fs.symlinkSync(os.homedir(), link);
  assert.equal(h.isAllowedPath(link), false);
});

// ── Snapshot ─────────────────────────────────────────────────────────────────

function gitRepo() {
  const repo = fs.mkdtempSync(path.join(TMP, 'repo-'));
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'a.js'), 'one\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(repo, 'server.pem'), 'key\n');
  fs.symlinkSync(os.homedir(), path.join(repo, 'home-link'));
  g('add', '-A'); g('commit', '-qm', 'one');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'nope\n');
  return { repo, g };
}

test('snapshot: pinned, tracked-only, secrets and symlinks excluded, read-only, verifiable', () => {
  const { repo, g } = gitRepo();
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dest = path.join(TMP, `snap-${Date.now()}`);
  const s = snapshot.create({ repo, revision: 'HEAD', dest });
  try {
    assert.equal(s.revision, sha);
    assert.deepEqual(s.excluded.sort(), ['.env', 'home-link', 'server.pem']);
    assert.ok(fs.existsSync(path.join(dest, 'sub', 'a.js')));
    assert.ok(!fs.existsSync(path.join(dest, 'untracked.txt')));
    assert.equal(s.nonreproducible, false);
    assert.throws(() => fs.writeFileSync(path.join(dest, 'sub', 'a.js'), 'pwned'), /EACCES|EPERM/);
    assert.equal(snapshot.verify(s), true);

    // Source moves on; the snapshot does not.
    fs.writeFileSync(path.join(repo, 'sub', 'a.js'), 'two\n');
    g('commit', '-qam', 'two');
    assert.equal(fs.readFileSync(path.join(dest, 'sub', 'a.js'), 'utf8'), 'one\n');

    // Tampering is detected.
    fs.chmodSync(path.join(dest, 'sub', 'a.js'), 0o644);
    fs.writeFileSync(path.join(dest, 'sub', 'a.js'), 'pwned');
    assert.equal(snapshot.verify(s), false);
  } finally {
    snapshot.remove(dest);
  }
  assert.ok(!fs.existsSync(dest));
});

test('snapshot: uncommitted changes mark a HEAD snapshot nonreproducible; subpath scopes the copy', () => {
  const { repo } = gitRepo();
  fs.writeFileSync(path.join(repo, 'sub', 'a.js'), 'dirty\n');
  const dest = path.join(TMP, `snap-sub-${Date.now()}`);
  const s = snapshot.create({ repo, subpath: 'sub', dest });
  try {
    assert.equal(s.path, path.join(dest, 'sub'));
    assert.deepEqual(s.dirty, ['sub/a.js']);
    assert.equal(s.nonreproducible, true);
    assert.equal(fs.readFileSync(path.join(s.path, 'a.js'), 'utf8'), 'one\n', 'snapshot is the commit, not the dirty file');
    assert.ok(!fs.existsSync(path.join(dest, '.env')));
  } finally {
    snapshot.remove(dest);
  }
});

// Two repos with shared history in content only (like public ARK, which was
// extracted from Seravanna): `host` keeps the package under lib/, `pub` at root.
function driftRepos() {
  const mk = () => {
    const repo = fs.mkdtempSync(path.join(TMP, 'drift-'));
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
    g('init', '-q');
    const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
    return { repo, g, w, commit: m => { g('add', '-A'); g('commit', '-qm', m); } };
  };
  const host = mk(); const pub = mk();
  for (const [r, pre] of [[host, 'lib/'], [pub, '']]) {
    r.w(`${pre}core/old.js`, 'v1\n');      // pub moves on → host behind
    r.w(`${pre}core/fixed.js`, 'v1\n');    // host moves on → pub behind
    r.w(`${pre}core/forked.js`, 'base\n'); // both edit → diverged
    r.w(`${pre}core/same.js`, 'same\n');
    r.commit('extract');
  }
  host.w('lib/core/fixed.js', 'v2 host fix\n');
  host.w('lib/core/forked.js', 'host edit\n');
  host.w('lib/core/hostonly.js', 'x\n');
  host.w('lib/other/skip.js', 'x\n');
  host.commit('host work');
  pub.w('core/old.js', 'v2 public refactor\n');
  pub.w('core/forked.js', 'public edit\n');
  pub.commit('public work');
  return { host, pub };
}

test('drift: direction from content in the other side\'s history; diffs and history written read-only', () => {
  const { host, pub } = driftRepos();
  const base = fs.mkdtempSync(path.join(TMP, 'drift-ws-'));
  const sb = { alias: 'public', repo: pub.repo, ...snapshot.create({ repo: pub.repo, dest: path.join(base, 'public') }) };
  const sh = { alias: 'host', repo: host.repo, ...snapshot.create({ repo: host.repo, subpath: 'lib', dest: path.join(base, 'host') }) };
  try {
    const m = drift.compare({ base: sb, head: sh, paths: ['core'], dest: path.join(base, 'drift'), root: base });
    const by = Object.fromEntries(m.files.map(f => [f.path, f]));
    assert.equal(by['core/old.js'].direction_hint, 'host_behind');
    assert.equal(by['core/fixed.js'].direction_hint, 'public_behind');
    assert.equal(by['core/forked.js'].direction_hint, 'diverged');
    assert.equal(by['core/same.js'].status, 'identical');
    assert.equal(by['core/hostonly.js'].status, 'only_in_host');
    assert.ok(!by['other/skip.js'], 'paths scopes the comparison');
    assert.equal(m.base.revision, sb.revision);

    const diff = fs.readFileSync(path.join(base, 'drift', 'diffs', 'core', 'old.js.diff'), 'utf8');
    assert.match(diff, /a\/public\/core\/old\.js/);
    assert.match(diff, /b\/host\/lib\/core\/old\.js/);
    assert.match(fs.readFileSync(path.join(base, 'drift', 'history', 'host', 'core', 'fixed.js.log'), 'utf8'), /host work/);
    assert.throws(() => fs.writeFileSync(path.join(base, 'drift', 'manifest.json'), '{}'), /EACCES|EPERM/);
  } finally {
    snapshot.remove(base);
  }
});

test('findings are grounded against the snapshot and pinned to its SHA', () => {
  const { _internals: HA } = require('../actions/HarnessActions');
  const { repo } = gitRepo();
  const dest = path.join(TMP, `ground-${Date.now()}`);
  const snap = { alias: 'host', ...snapshot.create({ repo, subpath: 'sub', dest }) };
  try {
    const [ok, bad, art] = HA._groundFindings([
      { title: 'real', evidence: ['host:a.js:1', '`host:sub/a.js:1-1`'] },
      { title: 'invented', evidence: ['host:a.js:99', 'host:nope.js:1', 'other:a.js:1', 'host:../../etc/passwd:1'] },
      { title: 'ark only', evidence: ['artifact:abc'] },
    ], [snap]);
    assert.equal(ok.grounded, true);
    assert.deepEqual(ok.evidence_refs.map(r => [r.ok, r.path, r.revision, r.line]), [[true, 'sub/a.js', snap.revision, 1], [true, 'sub/a.js', snap.revision, 1]]);
    assert.equal(bad.grounded, false);
    assert.deepEqual(bad.evidence_refs.map(r => r.ok), [false, false, false, false]);
    assert.equal(art.grounded, false);
    assert.equal(art.evidence_refs[0].kind, 'artifact');
    assert.equal(HA._groundFindings(null, [snap]), null);
  } finally {
    snapshot.remove(dest);
  }
});

test.after(() => {
  try { execFileSync('chmod', ['-R', 'u+w', TMP]); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('harness capabilities are owner-only (rank 100); PARTNER and GUEST get nothing', () => {
  const { _internals: T } = require('../actions/TraceActions');
  assert.deepEqual(T._defaultCapabilities('harness', 'run', 100), ['harness.read', 'harness.execute']);
  assert.deepEqual(T._defaultCapabilities('harness', 'run', 80), []);
  assert.deepEqual(T._defaultCapabilities('harness', 'describe', 0), []);
});

// ── ARK callback (M2) ────────────────────────────────────────────────────────

test('drivers wire the ark MCP server only when a run has ARK access', () => {
  const claude = H.KINDS['claude-code'].build({ prompt: 'p', mcpConfigPath: '/tmp/m.json' }, { limits: {} }).args;
  assert.equal(claude[claude.indexOf('--mcp-config') + 1], '/tmp/m.json');
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], 'mcp__ark__ark_dispatch');
  assert.ok(!H.KINDS['claude-code'].build({ prompt: 'p' }, { limits: {} }).args.includes('--mcp-config'));

  const copilot = H.KINDS.copilot.build({ prompt: 'p', mcpConfigPath: '/tmp/m.json' }, { limits: {} }).args;
  assert.ok(copilot.includes('--available-tools=view,grep,glob,ark-ark_dispatch'));
  assert.ok(copilot.includes('--additional-mcp-config=@/tmp/m.json') && copilot.includes('--allow-tool=ark'));
  assert.ok(H.KINDS.copilot.build({ prompt: 'p' }, { limits: {} }).args.includes('--available-tools=view,grep,glob'));

  const cfg = H.KINDS['claude-code'].mcpConfig({ command: 'node', args: ['shim.js'], env: { A: '1' } });
  assert.deepEqual(cfg.mcpServers.ark, { type: 'stdio', command: 'node', args: ['shim.js'], env: { A: '1' } });
});

test('the MCP config file is private and removed after the attempt', async () => {
  const seen = path.join(TMP, `mcp-seen-${Date.now()}`);
  const cli = fakeCli('claude', `
    const i = process.argv.indexOf('--mcp-config'); const f = process.argv[i + 1];
    require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ f, mode: require('fs').statSync(f).mode & 0o777 }));
    console.log(JSON.stringify({ subtype: 'success', is_error: false, result: 'ok' }));
  `);
  const h = adapter([{ name: 'claude', kind: 'claude-code', bin: cli }]);
  await h.run(req({ mcp: { command: 'node', args: ['x'], env: { ARK_CALLBACK_TOKEN: 't' } } }));
  const { f, mode } = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(mode, 0o600);
  assert.equal(fs.existsSync(f), false);
});

test('callback: wrong token is 401, ungranted action is 403 and recorded as denied', async () => {
  const { _internals: HA } = require('../actions/HarnessActions');
  const calls = [];
  const cb = await HA._openCallback({ ctx: { store_id: 1, user_id: 'u', role: 'ADMIN', rank: 100 }, actions: ['artifact.search'], calls, delegation: { via: 'harness' } });
  try {
    const post = (token, body) => fetch(`${cb.url}/dispatch`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await post('nope', { action: 'artifact.search' })).status, 401);
    const denied = await post(cb.token, { action: 'artifact.update', payload: { artifact_id: 'x', title: 'pwned' } });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /not granted/);
    assert.deepEqual(calls.map(c => [c.action, c.denied]), [['artifact.update', true]]);
    assert.equal((await fetch(`${cb.url}/other`, { method: 'POST' })).status, 404);
  } finally {
    await cb.close();
  }
  await assert.rejects(fetch(`${cb.url}/dispatch`, { method: 'POST' }), 'callback is gone after the run');
});

test('capability → action grant is read-only plus task.propose', () => {
  const { _internals: HA } = require('../actions/HarnessActions');
  const all = Object.values(HA.CAPABILITY_ACTIONS).flat();
  assert.ok(all.every(a => /\.(search|get|list|events\.list)$/.test(a) || a === 'task.propose'), all.join(','));
});

test('MCP shim: initialize, tools/list and tools/call forwarded with the bearer token', async () => {
  const http = require('http');
  const seen = [];
  const server = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => { seen.push({ auth: rq.headers.authorization, body: JSON.parse(b) }); rs.writeHead(200); rs.end('{"artifacts":[]}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { spawn } = require('child_process');
  const shim = spawn(process.execPath, [path.resolve(__dirname, '../utils/arkMcpShim.js')], {
    env: { ARK_CALLBACK_URL: `http://127.0.0.1:${server.address().port}`, ARK_CALLBACK_TOKEN: 'tok', ARK_ALLOWED_ACTIONS: '["artifact.search"]' },
  });
  const replies = [];
  let buf = '';
  shim.stdout.on('data', d => { buf += d; let n; while ((n = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } });
  const sendMsg = m => shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const waitFor = async id => { for (let i = 0; i < 100; i++) { const r = replies.find(x => x.id === id); if (r) return r; await new Promise(r => setTimeout(r, 20)); } throw new Error(`no reply ${id}`); };
  try {
    sendMsg({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal((await waitFor(1)).result.serverInfo.name, 'ark');
    sendMsg({ method: 'notifications/initialized' });
    sendMsg({ id: 2, method: 'tools/list' });
    const [tool] = (await waitFor(2)).result.tools;
    assert.equal(tool.name, 'ark_dispatch');
    assert.deepEqual(tool.inputSchema.properties.action.enum, ['artifact.search']);
    sendMsg({ id: 3, method: 'tools/call', params: { name: 'ark_dispatch', arguments: { action: 'artifact.search', payload: { q: 'harness' } } } });
    const call = await waitFor(3);
    assert.equal(call.result.content[0].text, '{"artifacts":[]}');
    assert.deepEqual(seen[0], { auth: 'Bearer tok', body: { action: 'artifact.search', payload: { q: 'harness' } } });
  } finally {
    shim.kill();
    server.close();
  }
});
