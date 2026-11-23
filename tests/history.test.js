'use strict';

// task.history: a task's timeline from recorded evidence — lifecycle events,
// run outcomes, and runs that predate run events — each saying where it
// came from and what that source can't tell.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-history-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
const history = async (task_id, extra = {}) => (await run('task.history', { task_id, ...extra })).data;

function fakeCli(name, body) {
  const file = path.join(TMP, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    `if (process.argv.includes('--version')) { console.log('${name} 1.0.0'); process.exit(0); }`,
    'let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {', body, '});',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}

function repo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), `${name}\n`);
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

const propose = async (title, dir) => (await run('task.propose', {
  title, inputs: { repositories: [{ alias: 'r', path: dir }] }, required_capabilities: ['repo.read'],
})).data.task;

before(async () => {
  _reset();
  const rateLimited = fakeCli('claude', `
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached' }));
    process.exit(1);
  `);
  const claudeOk = fakeCli('claude', `
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'report', total_cost_usd: 0.25, num_turns: 1, modelUsage: { 'claude-opus-5-5': {} } }));
  `);
  await bootstrap({
    db: { driver: 'sqlite', path: path.join(TMP, 'history.sqlite') },
    harness: { drivers: [{ name: 'limited', kind: 'claude-code', bin: rateLimited }, { name: 'claude', kind: 'claude-code', bin: claudeOk }], allowed_roots: [TMP] },
  });
});
after(() => { _reset(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('task.history: lifecycle, newest first, from the task and its events', async () => {
  const t = await propose('Lifecycle', repo('life'));
  let h = await history(t.id);
  assert.deepEqual(h.entries.map(e => [e.type, e.evidence]), [['task.proposed', 'artifact']]);
  assert.deepEqual(h.summary.runs, { succeeded: 0, failed: 0, cancelled: 0, cached: 0 });
  assert.equal(h.summary.usage, null);

  await run('task.approve', { task_id: t.id, note: 'go' });
  await run('task.revise', { task_id: t.id, changes: { constraints: { max_files: 10 } }, note: 'narrower' });
  await run('task.approve', { task_id: t.id });
  h = await history(t.id);
  assert.deepEqual(h.entries.map(e => e.type), ['task.approved', 'task.revised', 'task.approved', 'task.proposed']);
  assert.ok(h.entries.every(e => e.kind === 'lifecycle' && e.missing.length === 0));
  assert.equal(h.entries[1].detail.note, 'narrower');
  assert.equal(h.entries[2].detail.note, 'go');
});

test('task.history: runs with their attempts, cost and ledger row; summary counts outcomes and usage', async () => {
  const t = await propose('Runs', repo('runs'));
  await run('task.approve', { task_id: t.id });
  const ok = await run('harness.run', { task_id: t.id });                       // limited → claude
  await run('harness.run', { task_id: t.id });                                  // cached
  const failed = await run('harness.run', { task_id: t.id, driver: 'limited' }).catch(e => e); // fails
  assert.ok(failed instanceof Error, 'the narrowed run fails');
  assert.ok(!(failed._log || []).some(l => /run event not recorded/.test(l)), `run event write failed: ${(failed._log || []).join(' | ')}`);
  assert.equal(failed.code, 'RATE_LIMITED', `${failed.code}: ${failed.message}`);

  const h = await history(t.id);
  const runs = h.entries.filter(e => e.kind === 'run');
  assert.deepEqual(runs.map(e => [e.run.outcome, e.run.cached]), [['failed', false], ['succeeded', true], ['succeeded', false]]);
  const first = runs[2];
  assert.deepEqual({ evidence: first.evidence, missing: first.missing, ledger_id: first.run.ledger_id, review_id: first.run.review_id, driver: first.run.driver },
    { evidence: 'event', missing: [], ledger_id: ok.meta.ledger_id, review_id: ok.data.review.id, driver: 'claude' });
  assert.deepEqual(first.run.attempts.map(a => [a.provider, a.ok, a.cost.basis]), [['limited', false, 'unknown'], ['claude', true, 'reported']]);
  assert.ok(runs[0].run.code);

  assert.deepEqual(h.summary.runs, { succeeded: 1, failed: 1, cancelled: 0, cached: 1 });
  assert.deepEqual({ calls: h.summary.usage.calls, failed: h.summary.usage.failed, usd: h.summary.usage.usd_reported, unpriced: h.summary.usage.unpriced },
    { calls: 3, failed: 2, usd: 0.25, unpriced: 2 }, 'a cached rerun adds no calls; failed attempts are unpriced, not $0');
  assert.equal(h.summary.runs_without_attempts, 0);
});

test('task.history: runs from before run events say what they are missing', async () => {
  const t = await propose('Legacy', repo('legacy'));
  await run('task.approve', { task_id: t.id });
  const task = await Artifact.findById(t.id, ADMIN);

  // A review produced the old way: no run event, its own attempts.
  const review = new Artifact({ artifact_type: 'review', title: 'Old review', context: { visibility: 'private' }, metadata: {
    task_id: t.id, run_key: 'old-key', model: 'claude-opus-5-5', harness: { driver: 'claude' }, findings: [{}, {}],
    started_at: '2026-11-01T10:00:00.000Z', ended_at: '2026-11-01T10:05:00.000Z',
    attempts: [{ driver: 'claude', ok: true, code: null, duration_ms: 300000, cost_usd: 0.4, requests: null }],
  } }, { context: ADMIN });
  await review.save();
  await new ArtifactRelation({ source_artifact_id: t.id, target_artifact_id: review.id, relation_type: 'produced', metadata: { run_key: 'old-key' } }, { context: ADMIN }).save();
  // A failure that only last_attempt remembers, with no attempt detail.
  task.assign({ context: { ...task.get('context'), last_attempt: { status: 'failed', run_key: 'gone-key', started_at: '2026-11-02T09:00:00.000Z', ended_at: '2026-11-02T09:00:01.000Z', code: 'HARNESS_UNAVAILABLE', message: 'no driver' } } });
  await task.save();

  const h = await history(t.id);
  const byId = Object.fromEntries(h.entries.map(e => [e.id, e]));
  const old = byId[`review:${review.id}`];
  assert.deepEqual({ evidence: old.evidence, missing: old.missing, findings: old.run.findings, at: old.at },
    { evidence: 'review', missing: ['ledger_id'], findings: 2, at: '2026-11-01T10:05:00.000Z' });
  assert.deepEqual(old.run.attempts[0].cost, { usd: 0.4, basis: 'reported' });
  const gone = byId['last_attempt:gone-key'];
  assert.deepEqual({ outcome: gone.run.outcome, code: gone.run.code, evidence: gone.evidence, missing: gone.missing },
    { outcome: 'failed', code: 'HARNESS_UNAVAILABLE', evidence: 'last_attempt', missing: ['ledger_id', 'attempts'] });
  assert.equal(h.summary.runs_without_attempts, 1);
  assert.deepEqual(h.summary.runs, { succeeded: 1, failed: 1, cancelled: 0, cached: 0 });

  // Once an event records that failure, last_attempt no longer adds a copy.
  await run('harness.run', { task_id: t.id, driver: 'limited' }).catch(() => {});
  const after = await history(t.id);
  assert.equal(after.entries.filter(e => e.evidence === 'last_attempt').length, 0, 'the event covers the latest failure');
  assert.equal(after.entries.filter(e => e.kind === 'run').length, 2, 'the old last_attempt was overwritten — only the review survives from before');
});

test('task.history: pages walk every entry once, in order', async () => {
  const t = await propose('Pages', repo('pages'));
  for (let i = 0; i < 3; i++) {
    await run('task.approve', { task_id: t.id });
    await run('task.revise', { task_id: t.id, changes: { constraints: { round: i } } });
  }
  const all = (await history(t.id, { limit: 100 })).entries.map(e => e.id);
  assert.equal(all.length, 7);
  const walked = [];
  let before = null;
  do {
    const page = await history(t.id, { limit: 2, ...(before ? { before } : {}) });
    assert.ok(page.entries.length <= 2);
    walked.push(...page.entries.map(e => e.id));
    before = page.next_before;
  } while (before);
  assert.deepEqual(walked, all);
});

test('task.history: as visible as the task; unknown ids are not found', async () => {
  const t = await propose('Private', repo('private'));
  // USER holds artifact.read; the private task's visibility is what refuses —
  // a 404, so its existence isn't confirmed.
  await assert.rejects(run('task.history', { task_id: t.id }, USER), err => err.status === 404 && err.code === 'NOT_FOUND');
  const task = await Artifact.findById(t.id, ADMIN);
  task.assign({ context: { ...task.get('context'), visibility: 'public' } });
  await task.save();
  assert.equal((await history(t.id)).entries[0].type, 'task.proposed');
  assert.deepEqual((await run('task.history', { task_id: t.id }, USER)).data.entries.map(e => e.type), ['task.proposed'], 'visible → readable at rank 10');
  await assert.rejects(run('task.history', { task_id: '00000000-0000-0000-0000-000000000000' }), err => err.code === 'NOT_FOUND');
  await assert.rejects(run('task.history', {}), err => err.code === 'MISSING_TASK_ID');
});

test('task.usage: a project\'s runs and spend, per provider, from the same evidence as task.history', async () => {
  const p = (await run('ark.create', { title: 'Spend' })).data.ark;
  const dir = repo('spend');
  const inProject = async title => (await run('task.propose', {
    project_id: p.id, title, inputs: { repositories: [{ alias: 'r', path: dir }] }, required_capabilities: ['repo.read'],
  })).data.task;
  const a = await inProject('A');
  const b = await inProject('B');
  await inProject('Never run');
  await run('repository.add', { project_id: p.id, alias: 'site', path: dir }); // a member that isn't a task
  await run('task.approve', { task_id: a.id });
  await run('task.approve', { task_id: b.id });
  await run('harness.run', { task_id: a.id });                                   // limited ✕ → claude ✓ $0.25
  await run('harness.run', { task_id: b.id, driver: 'limited' }).catch(() => {}); // limited ✕
  const outside = await propose('Elsewhere', repo('outside'));
  await run('task.approve', { task_id: outside.id });
  await run('harness.run', { task_id: outside.id });                             // not in the project

  const u = (await run('task.usage', { project_id: p.id })).data;
  assert.equal(u.tasks, 3);
  assert.deepEqual(u.runs, { succeeded: 1, failed: 1, cancelled: 0, cached: 0 });
  assert.deepEqual({ calls: u.usage.calls, failed: u.usage.failed, usd: u.usage.usd_reported, unpriced: u.usage.unpriced }, { calls: 3, failed: 2, usd: 0.25, unpriced: 2 });
  assert.deepEqual(Object.keys(u.by_provider).sort(), ['claude', 'limited']);
  assert.deepEqual({ calls: u.by_provider.claude.calls, usd: u.by_provider.claude.usd_reported }, { calls: 1, usd: 0.25 });
  assert.deepEqual({ calls: u.by_provider.limited.calls, failed: u.by_provider.limited.failed, unpriced: u.by_provider.limited.unpriced }, { calls: 2, failed: 2, unpriced: 2 });

  const empty = (await run('task.usage', { project_id: (await run('ark.create', { title: 'Quiet' })).data.ark.id })).data;
  assert.deepEqual({ tasks: empty.tasks, usage: empty.usage, by_provider: empty.by_provider }, { tasks: 0, usage: null, by_provider: {} });
  await assert.rejects(run('task.usage', { project_id: a.id }), err => err.code === 'PROJECT_NOT_FOUND', 'a task is not a project');
  await assert.rejects(run('task.usage', {}), err => err.code === 'MISSING_PROJECT_ID');
});

test('task.history: same-instant ties keep their real order', async () => {
  const t = await propose('Ties', repo('ties'));
  const task = await Artifact.findById(t.id, ADMIN);
  // An event stamped at the task's own creation instant, with an id that
  // would sort after "task:…": creation still comes first (oldest).
  await Artifact.db.from('artifact_events').insert({
    id: 'zzzz-same-instant', store_id: 1, artifact_id: t.id, event_type: 'task.note', event_name: 'Same instant',
    payload: {}, created_at: new Date(task.get('created_at')).toISOString(),
  }).select('*').single();
  const h = await history(t.id);
  assert.deepEqual(h.entries.map(e => e.type), ['task.note', 'task.proposed']);
  const p1 = await history(t.id, { limit: 1 });
  const p2 = await history(t.id, { limit: 1, before: p1.next_before });
  assert.deepEqual([...p1.entries, ...p2.entries].map(e => e.type), ['task.note', 'task.proposed'], 'the cursor follows the same order');
  assert.equal(p2.next_before, null);

  // sqlite: event rows written back to back never share a timestamp.
  const stamps = [];
  for (let i = 0; i < 20; i++) {
    const { data } = await Artifact.db.from('artifact_events').insert({ store_id: 1, artifact_id: t.id, event_type: 'task.tick', event_name: 'tick', payload: {} }).select('*').single();
    stamps.push(data.created_at);
  }
  assert.equal(new Set(stamps).size, 20);
  assert.deepEqual([...stamps].sort(), stamps, 'strictly increasing in insert order');
});
