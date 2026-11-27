'use strict';

// approval.queue: everything waiting on the owner, read in one place over the
// approvals that already exist; review.dismiss, its one write.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const { seedProjectTemplates } = require('../cli/seedProjects');
const Artifact = require('../domain/Artifact');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-approvals-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
const queue = async () => (await run('approval.queue')).data;
const kinds = q => q.items.map(i => `${i.kind}:${i.id}`).sort();

function repo(name, files) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  const write = fs2 => { for (const [f, body] of Object.entries(fs2)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); } };
  write(files);
  g('add', '.');
  g('commit', '-qm', 'init');
  return { dir, change: (f2, msg) => { write(f2); g('add', '.'); g('commit', '-qm', msg); } };
}

before(async () => {
  _reset();
  const bin = path.join(TMP, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'drift report', total_cost_usd: 0.1, num_turns: 1, modelUsage: {} }));
});`);
  fs.chmodSync(bin, 0o755);
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'a.sqlite') }, harness: { drivers: [{ name: 'claude', kind: 'claude-code', bin }], allowed_roots: [TMP] } });
  await seedProjectTemplates(dispatch, ADMIN);
});
after(() => { _reset(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('approval.queue and review.dismiss are owner-only', async () => {
  await assert.rejects(run('approval.queue', {}, USER), err => err.code === 'CAPABILITY_DENIED');
  await assert.rejects(run('review.dismiss', { review_id: 'x' }, USER), err => err.code === 'CAPABILITY_DENIED');
});

test('approval.queue: proposed tasks, runs, gated steps and scheduled workflows — each leaves once approved', async () => {
  const start = await queue();
  const p = (await run('ark.create', { title: 'Queue', template_id: 'project-developer' })).data.ark;

  const task = (await run('task.propose', { project_id: p.id, title: 'look at the gateway' })).data.task;
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'gate', title: 'Gate', steps: [{ key: 'a', title: 'A', mode: 'human', gate: true }] })).data.workflow;
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'gate' })).data.run;
  const ev = (await run('event.create', {
    project_id: p.id, title: 'Nightly gate', event_type: 'dev.review', timezone: 'UTC',
    schedule: { kind: 'every', every: '1d', start_at: new Date().toISOString() }, action_ref: { kind: 'workflow', alias: 'gate' },
  })).data.event;

  let q = await queue();
  const added = q.items.filter(i => !start.items.some(s => s.id === i.id));
  assert.deepEqual(added.map(i => i.kind).sort(), ['event', 'run', 'task']);
  assert.equal(added.find(i => i.kind === 'event').reason, 'not_approved');
  assert.deepEqual(added.find(i => i.kind === 'task').settle, ['task.approve']);
  assert.equal(q.counts.total, q.items.length);

  // Approving through the existing actions is what clears them.
  await run('task.approve', { task_id: task.id });
  await run('event.approve_workflow', { event_id: ev.id });
  await run('workflow.approve', { run_id: launched.id });
  q = await queue();
  assert.ok(!q.items.some(i => [task.id, ev.id, launched.id].includes(i.id)), 'approved items leave the queue');
  // The run's gated step now waits on its own approval.
  const gated = q.items.find(i => i.kind === 'gated_step' && i.run_id === launched.id);
  assert.ok(gated, 'a gated step is in the queue');
  assert.equal(gated.step, 'a');

  // The workflow changes under the standing approval: the schedule is stale.
  await run('workflow.redefine', { workflow_id: wf.id, changes: { steps: [{ key: 'b', title: 'B', mode: 'human' }] } });
  const stale = (await queue()).items.find(i => i.id === ev.id);
  assert.equal(stale.reason, 'stale');
  assert.deepEqual([stale.approved_revision, stale.revision], [1, 2]);
});

test('drift reviews: queued until a PR intent is made from one, or it is dismissed (recorded, once)', async () => {
  const pub = repo('pub', { 'core/a.js': 'a\n', 'core/b.js': 'b\n' });
  const host = repo('host', { 'lib/core/a.js': 'a, forked\n', 'lib/core/b.js': 'b\n' });
  const task = new Artifact({ artifact_type: 'task', title: 'Watch drift', body: 'drift', context: {
    state: 'ready', visibility: 'private', required_capabilities: ['repo.read'],
    inputs: { repositories: [{ alias: 'public', path: pub.dir }, { alias: 'host', path: host.dir, subpath: 'lib' }], compare: { base: 'public', head: 'host', paths: ['core'] } },
  } }, { context: ADMIN });
  await task.save();

  const first = (await run('harness.watch', { task_id: task.id })).data;
  assert.equal(first.status, 'reviewed');
  let item = (await queue()).items.find(i => i.kind === 'review' && i.id === first.review.id);
  assert.ok(item, 'a new drift review is queued');
  assert.deepEqual(item.drift, { new: 1, changed: 0, drifting: 1 });
  assert.equal(item.task_id, task.id);
  assert.deepEqual(item.settle, ['task.propose', 'review.dismiss']);

  // Dismissed: out of the queue, recorded on the review and in its history.
  const d = (await run('review.dismiss', { review_id: first.review.id, note: 'known fork' })).data;
  assert.equal(d.dismissed.note, 'known fork');
  assert.equal(d.dismissed.by, 'actor-admin');
  assert.ok(!(await queue()).items.some(i => i.id === first.review.id));
  const events = (await run('artifact.get', { artifact_id: first.review.id })).data.events.map(e => e.event_type);
  assert.ok(events.includes('review.dismissed'));
  await assert.rejects(run('review.dismiss', { review_id: first.review.id }), err => err.code === 'ALREADY_DISMISSED');
  assert.equal(events.filter(e => e === 'review.dismissed').length, 1);
  await assert.rejects(run('review.dismiss', { review_id: task.id }), err => err.code === 'NOT_FOUND', 'only a review');

  // New drift → a new review → a PR intent made from it takes it out too
  // (the PR intent itself now waits for approval).
  host.change({ 'lib/core/b.js': 'b, forked too\n' }, 'more drift');
  const second = (await run('harness.watch', { task_id: task.id, force: true })).data;
  assert.equal(second.status, 'reviewed');
  assert.ok((await queue()).items.some(i => i.id === second.review.id));
  const pr = (await run('task.propose', { kind: 'pr', title: 'Sync b.js', pr: { repository: { alias: 'host', path: host.dir } }, derived_from: second.review.id })).data.task;
  const q = await queue();
  assert.ok(!q.items.some(i => i.id === second.review.id), 'a review with a PR intent leaves the queue');
  const prItem = q.items.find(i => i.id === pr.id);
  assert.equal(prItem.kind, 'pr_intent');
  assert.equal(prItem.derived_from, second.review.id);
});

test('one tick: overlapping ark cycle runs watch a scheduled drift task once', async () => {
  const pub = repo('pub2', { 'core/a.js': 'a\n' });
  const host = repo('host2', { 'lib/core/a.js': 'a, forked\n' });
  const task = new Artifact({ artifact_type: 'task', title: 'Watch drift 2', body: 'drift', context: {
    state: 'ready', visibility: 'private', required_capabilities: ['repo.read'], schedule: { every: '1h' },
    inputs: { repositories: [{ alias: 'public', path: pub.dir }, { alias: 'host', path: host.dir, subpath: 'lib' }], compare: { base: 'public', head: 'host', paths: ['core'] } },
  } }, { context: ADMIN });
  await task.save();
  const HOUR = 3600000;
  const ev = (await run('event.create', {
    title: 'hourly drift', event_type: 'dev.review', timezone: 'UTC',
    schedule: { kind: 'every', every: '1h', start_at: new Date(Date.now() - 3 * HOUR - 60000).toISOString() },
    action_ref: { kind: 'task', id: task.id },
  })).data.event;
  // active_since is set to now by event.create; backdate it so the latest occurrence counts.
  const e = await Artifact.findById(ev.id, ADMIN);
  await Artifact.db.from('artifacts').update({ context: { ...e.get('context'), active_since: new Date(Date.now() - 4 * HOUR).toISOString() } }).eq('id', ev.id);

  const ticks = await Promise.all([1, 2, 3].map(() => run('system.cycle', { wait: true })));
  const fired = ticks.flatMap(t => t.data.results.filter(r => r.event_id === ev.id));
  assert.equal(fired.length, 1, 'one occurrence, claimed once');
  assert.equal(fired[0].outcome, 'dispatched');
  assert.equal(fired[0].result.action, 'harness.watch');
  assert.equal(fired[0].result.status, 'reviewed');
  const c = (await Artifact.findById(task.id, ADMIN)).get('context');
  assert.equal(c.watch.checks.length, 1, 'the drift task was checked once');
});

test('review.dismiss: of two at once, one lands and the other records nothing', async () => {
  const review = (await run('artifact.create', { artifact_type: 'review', title: 'Review: race' })).data.artifact;
  const both = await Promise.allSettled([
    run('review.dismiss', { review_id: review.id, note: 'first' }),
    run('review.dismiss', { review_id: review.id, note: 'second' }),
  ]);
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['ALREADY_DISMISSED', 'CONFLICT'].includes(both.find(r => r.status === 'rejected').reason.code));
  const won = both.find(r => r.status === 'fulfilled').value.data.dismissed.note;
  const c = (await Artifact.findById(review.id, ADMIN)).get('context');
  assert.equal(c.dismissed.note, won, 'the stored dismissal is the one that succeeded');
  const events = (await run('artifact.get', { artifact_id: review.id })).data.events.filter(e => e.event_type === 'review.dismissed');
  assert.equal(events.length, 1);
});

test('approval.queue says when a source has more candidates than it reads', async () => {
  const { _setCap } = require('../actions/ApprovalActions')._internals;
  for (let i = 0; i < 3; i++) await run('task.propose', { title: `overflow ${i}` });
  _setCap(2);
  try {
    const q = await queue();
    assert.ok(q.truncated.includes('tasks'), JSON.stringify(q.truncated));
    assert.ok(q.items.filter(i => i.kind === 'task' || i.kind === 'pr_intent' || i.kind === 'gated_step').length <= 2);
  } finally { _setCap(1000); }
  assert.deepEqual((await queue()).truncated, []);
});
