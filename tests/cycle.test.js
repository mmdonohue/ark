'use strict';

// system.cycle on a throwaway sqlite vessel: occurrence claims (at most once),
// misfire coalescing, active_since, and governed work requests.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch, ACTION_REGISTRY } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');
const ChainExecutor = require('../core/ChainExecutor');
const { occurrenceId } = require('../actions/SystemActions')._internals;

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-cycle-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
const HOUR = 3600000;
const iso = ms => new Date(ms).toISOString();

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'cycle.sqlite') } });
});

// An hourly event whose schedule started `hoursAgo` and that has been active
// for `activeHours` — active_since is set by the event actions, so tests
// backdate it directly.
async function hourly({ hoursAgo = 5, activeHours = 5, action_ref } = {}) {
  const ev = (await run('event.create', {
    title: 'hourly check', event_type: 'dev.check', timezone: 'UTC',
    schedule: { kind: 'every', every: '1h', start_at: iso(Date.now() - hoursAgo * HOUR - 60000) },
    ...(action_ref ? { action_ref } : {}),
  })).data.event;
  await backdate(ev.id, activeHours);
  return ev;
}

async function backdate(id, hours) {
  const ev = await Artifact.findById(id, ADMIN);
  const { error } = await Artifact.db.from('artifacts')
    .update({ context: { ...ev.get('context'), active_since: iso(Date.now() - hours * HOUR - 120000) } }).eq('id', id);
  assert.equal(error, null);
}

const mine = (r, id) => r.data.results.filter(x => x.event_id === id);
const chain = async id => (await Artifact.db.from('artifact_chains').select('*').eq('id', id).single()).data;
const history = async id => (await run('artifact.get', { artifact_id: id })).data.events;

test('occurrenceId: deterministic UUIDv5, distinct per version and due time', () => {
  const a = occurrenceId('e1', 1, '2026-11-16T09:00:00.000Z');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, occurrenceId('e1', 1, '2026-11-16T09:00:00.000Z'));
  assert.notEqual(a, occurrenceId('e1', 2, '2026-11-16T09:00:00.000Z'));
  assert.notEqual(a, occurrenceId('e1', 1, '2026-11-16T10:00:00.000Z'));
});

test('cycle: fires the latest due occurrence once; missed ones coalesce', async () => {
  const ev = await hourly();
  const first = mine(await run('system.cycle'), ev.id);
  assert.equal(first.length, 1, 'five missed hours → one firing');
  assert.equal(first[0].outcome, 'occurred');
  assert.ok(Date.now() - Date.parse(first[0].due_at) < HOUR, 'the latest one');

  const c = await chain(first[0].occurrence_id);
  assert.equal(c.status, 'occurred');
  assert.equal(c.action, 'event.occurrence');
  assert.equal(c.context.event_id, ev.id);

  const again = await run('system.cycle');
  assert.equal(mine(again, ev.id).length, 0);
  assert.ok(again.data.already_claimed >= 1);

  const occurred = (await history(ev.id)).filter(e => e.event_type === 'event.occurred');
  assert.equal(occurred.length, 1);
  assert.equal(occurred[0].payload.occurrence_id, first[0].occurrence_id);
});

test('cycle: concurrent cycles claim an occurrence exactly once', async () => {
  const ev = await hourly();
  const all = await Promise.all([run('system.cycle'), run('system.cycle'), run('system.cycle')]);
  assert.equal(all.flatMap(r => mine(r, ev.id)).length, 1);
});

test('cycle: nothing that came due before active_since fires', async () => {
  const ev = await hourly({ hoursAgo: 5.5, activeHours: 0 });
  // active_since is 2 minutes ago; the last hourly occurrence was ~31 minutes ago.
  assert.equal(mine(await run('system.cycle'), ev.id).length, 0);

  // Resuming resets active_since: what came due while paused doesn't fire.
  const ev2 = await hourly();
  await run('event.pause', { event_id: ev2.id });
  assert.equal(mine(await run('system.cycle'), ev2.id).length, 0, 'paused');
  await run('event.resume', { event_id: ev2.id });
  assert.equal(mine(await run('system.cycle'), ev2.id).length, 0, 'resumed just now');
});

test('cycle: a reschedule is a new occurrence identity', async () => {
  const ev = await hourly();
  const [a] = mine(await run('system.cycle'), ev.id);
  await run('event.update', { event_id: ev.id, schedule: { kind: 'every', every: '2h', start_at: iso(Date.now() - 4 * HOUR - 60000) } });
  await backdate(ev.id, 5);
  const [b] = mine(await run('system.cycle'), ev.id);
  assert.equal(b.schedule_version, 2);
  assert.notEqual(b.occurrence_id, a.occurrence_id);
});

test('cycle: dry_run reports what is due and claims nothing', async () => {
  const ev = await hourly();
  const [dry] = mine(await run('system.cycle', { dry_run: true }), ev.id);
  assert.equal(dry.outcome, 'due');
  assert.equal(await chain(dry.occurrence_id), null);
  const [real] = mine(await run('system.cycle'), ev.id);
  assert.equal(real.occurrence_id, dry.occurrence_id);
});

test('cycle: work for a task that is not ready is blocked, and the claim still holds', async () => {
  const task = (await run('artifact.create', { artifact_type: 'task', title: 'nightly review' })).data.artifact;
  const ev = await hourly({ action_ref: { kind: 'task', id: task.id } });
  const [r] = mine(await run('system.cycle'), ev.id);
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.error.code, 'TASK_NOT_READY');
  assert.equal((await chain(r.occurrence_id)).status, 'blocked');
  assert.equal(mine(await run('system.cycle'), ev.id).length, 0);
});

test('cycle: a ready task is requested through dispatch() with the caller\'s identity', async () => {
  const task = (await run('artifact.create', { artifact_type: 'task', title: 'drift check', context: { inputs: { compare: { base: 'a', head: 'b' } } } })).data.artifact;
  await run('task.approve', { task_id: task.id });
  const ev = await hourly({ action_ref: { kind: 'task', id: task.id } });

  const real = ACTION_REGISTRY['harness.watch'].handler;
  const seen = [];
  ACTION_REGISTRY['harness.watch'].handler = async (ctx, payload) => { seen.push({ ctx, payload }); return { data: { status: 'not_due' } }; };
  try {
    const [r] = mine(await run('system.cycle'), ev.id);
    assert.equal(r.outcome, 'dispatched');
    assert.deepEqual(r.result, { action: 'harness.watch', status: 'not_due' });
  } finally {
    ACTION_REGISTRY['harness.watch'].handler = real;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.task_id, task.id);
  assert.equal(seen[0].ctx.source, 'system.cycle');
  assert.equal(seen[0].ctx.ark_actor_id, ADMIN.ark_actor_id);

  const { ledger } = (await run('ledger.list', { limit: 20 })).data;
  assert.ok(ledger.some(l => l.action === 'harness.watch'), 'the work has its own ledger entry');
});

test('cycle: owner/admin only', async () => {
  await assert.rejects(run('system.cycle', {}, USER), err => err.status === 403);
});

test('claim rows are invisible to ChainExecutor.resume()', async () => {
  const ev = await hourly();
  const [r] = mine(await run('system.cycle'), ev.id);
  // Simulate a crash between claim and settle.
  await Artifact.db.from('artifact_chains').update({ status: 'claimed', completed_at: null }).eq('id', r.occurrence_id);
  const { data } = await Artifact.db.from('artifact_chains').select('id').in('status', ['pending', 'running']);
  assert.ok(!(data || []).some(c => c.id === r.occurrence_id));
  await ChainExecutor.resume(ACTION_REGISTRY); // must not throw or touch it
  assert.equal((await chain(r.occurrence_id)).status, 'claimed');
});
