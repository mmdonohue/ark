'use strict';

// Scheduled events: schedule math (DST included) and event.* through
// dispatch() on a throwaway sqlite vessel.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../utils/eventSchedule');
const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');

const LA = 'America/Los_Angeles';
const iso = ms => new Date(ms).toISOString();
const locals = (sched, tz, from, limit) => S.occurrences(sched, tz, { from: Date.parse(from), limit }).map(t => S.localString(t, tz));

// ── schedule math ────────────────────────────────────────────────────────────

test('zonedToUtc: ordinary time, spring-forward gap, fall-back overlap', () => {
  assert.equal(iso(S.parseLocal('2026-11-16T09:00', LA)), '2026-11-16T17:00:00.000Z');
  // 02:30 doesn't exist on 2026-03-08 in LA → shifted forward by the gap
  assert.equal(S.localString(S.parseLocal('2026-03-08T02:30', LA), LA), '2026-03-08T03:30');
  // 01:30 happens twice on 2026-11-01 → the first (PDT) instance
  assert.equal(iso(S.parseLocal('2026-11-01T01:30', LA)), '2026-11-01T08:30:00.000Z');
  assert.equal(S.parseLocal('2026-02-30T09:00', LA), null);
  assert.equal(S.parseLocal('nope', LA), null);
});

test('every <n>d keeps local wall time across DST; every <n>h stays absolute', () => {
  const start_at = iso(S.parseLocal('2026-03-06T09:00', LA));
  assert.deepEqual(locals({ kind: 'every', every: '1d', start_at }, LA, '2026-03-06T00:00Z', 4),
    ['2026-03-06T09:00', '2026-03-07T09:00', '2026-03-08T09:00', '2026-03-09T09:00']);
  assert.deepEqual(locals({ kind: 'every', every: '24h', start_at }, LA, '2026-03-06T00:00Z', 4),
    ['2026-03-06T09:00', '2026-03-07T09:00', '2026-03-08T10:00', '2026-03-09T10:00']);
  const fallStart = iso(S.parseLocal('2026-10-30T09:00', LA));
  assert.deepEqual(locals({ kind: 'every', every: '1d', start_at: fallStart }, LA, '2026-10-30T00:00Z', 4),
    ['2026-10-30T09:00', '2026-10-31T09:00', '2026-11-01T09:00', '2026-11-02T09:00']);
});

test('occurrences: window, end bound, weeks, far-future start of window, once', () => {
  const start_at = iso(S.parseLocal('2026-01-05T09:00', LA));
  assert.deepEqual(locals({ kind: 'every', every: '1w', start_at }, LA, '2026-10-25T00:00Z', 3),
    ['2026-10-26T09:00', '2026-11-02T09:00', '2026-11-09T09:00']);
  const bounded = { kind: 'every', every: '1d', start_at, end_at: iso(S.parseLocal('2026-01-07T12:00', LA)) };
  assert.equal(S.occurrences(bounded, LA, { from: 0, limit: 10 }).length, 3);
  const once = { kind: 'once', start_at };
  assert.equal(S.occurrences(once, LA, { from: Date.parse(start_at), to: Date.parse(start_at) + 1 }).length, 1);
  assert.equal(S.occurrences(once, LA, { from: Date.parse(start_at) + 1 }).length, 0);
  assert.equal(S.parseEvery('0d'), null);
  assert.equal(S.parseEvery('2m'), null);
  assert.deepEqual(S.parseEvery('3w'), { n: 3, unit: 'w' });
});

// ── actions ──────────────────────────────────────────────────────────────────

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-events-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
let project, other;

const nextMonday = () => {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
};
const create = (extra = {}) => run('event.create', {
  title: 'Weekly architecture review', event_type: 'dev.review', timezone: LA, project_id: project.id,
  schedule: { kind: 'every', every: '1w', start_local: `${nextMonday()}T09:00` }, ...extra,
}).then(r => r.data.event);
const history = async id => (await run('artifact.get', { artifact_id: id })).data.events.map(e => e.event_type);

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'events.sqlite') } });
  project = (await run('ark.create', { title: 'ARK' })).data.ark;
  other   = (await run('ark.create', { title: 'Farm' })).data.ark;
});

test('event.create: validated schedule, placed in the project, recorded in history', async () => {
  const ev = await create();
  const c = ev.context;
  assert.deepEqual([c.event_type, c.state, c.timezone, c.schedule.kind, c.schedule.every, c.schedule_version], ['dev.review', 'active', LA, 'every', '1w', 1]);
  assert.equal(S.localString(Date.parse(c.schedule.start_at), LA).slice(11), '09:00');
  assert.ok((await history(ev.id)).includes('event.scheduled'));
  const { data } = await run('event.list', { project_id: project.id, days: 30 });
  assert.ok(data.events.some(e => e.id === ev.id));
  assert.ok(data.occurrences.filter(o => o.event_id === ev.id).length >= 4);
  assert.ok(data.occurrences.every(o => o.local.endsWith('09:00')));
});

test('event.create: rejects bad input with specific codes', async () => {
  const bad = async (extra, code) => assert.rejects(create(extra), err => err.code === code, `${JSON.stringify(extra)} → ${code}`);
  await bad({ timezone: 'Mars/Olympus' }, 'BAD_TIMEZONE');
  await bad({ event_type: 'Dev Review' }, 'BAD_EVENT_TYPE');
  await bad({ schedule: { kind: 'every', every: '2m', start_local: '2030-01-01T09:00' } }, 'BAD_SCHEDULE');
  await bad({ schedule: { kind: 'once', start_local: '2020-01-01T09:00' } }, 'BAD_SCHEDULE');
  await bad({ schedule: { kind: 'once', start_at: '2030-01-01T09:00' } }, 'BAD_SCHEDULE'); // no offset
  await bad({ schedule: { kind: 'once', start_at: '2030-01-01T09:00Z', start_local: '2030-01-01T09:00' } }, 'BAD_SCHEDULE');
  await bad({ schedule: { kind: 'every', every: '1d', start_local: '2030-01-05T09:00', end_local: '2030-01-01T09:00' } }, 'BAD_SCHEDULE');
  const note = (await run('artifact.create', { artifact_type: 'note', title: 'n' })).data.artifact;
  await bad({ action_ref: { kind: 'task', id: note.id } }, 'ACTION_REF_NOT_FOUND');
  await assert.rejects(create({}).then(() => run('event.create', { title: 'x' }, USER)), err => err.code === 'CAPABILITY_DENIED');
});

test('event.list: project-scoped, window-bounded, capped; paused and cancelled have no occurrences', async () => {
  const farm = await run('event.create', { title: 'Irrigation check', event_type: 'farm.irrigation_check', timezone: LA,
    project_id: other.id, schedule: { kind: 'every', every: '6h', start_local: `${nextMonday()}T06:00` } }).then(r => r.data.event);

  const mine = (await run('event.list', { project_id: project.id, days: 30 })).data;
  assert.ok(!mine.events.some(e => e.id === farm.id), 'other projects\' events stay out');

  const capped = (await run('event.list', { project_id: other.id, days: 60, limit: 10 })).data;
  assert.equal(capped.occurrences.length, 10);
  assert.equal(capped.truncated, true);
  await assert.rejects(run('event.list', { days: 1, to: '2020-01-01T00:00Z' }), err => err.code === 'BAD_WINDOW');
  await assert.rejects(run('event.list', { from: '2026-01-01T00:00Z', to: '2028-01-01T00:00Z' }), err => err.code === 'BAD_WINDOW');

  await run('event.pause', { event_id: farm.id });
  assert.equal((await run('event.list', { project_id: other.id })).data.events.length, 0, 'paused hidden by default');
  const withPaused = (await run('event.list', { project_id: other.id, include_paused: true })).data;
  assert.equal(withPaused.events[0].state, 'paused');
  assert.equal(withPaused.occurrences.length, 0);
});

test('pause / resume / cancel: allowed transitions only; cancelled is final', async () => {
  const ev = await create({ title: 'lifecycle' });
  await assert.rejects(run('event.resume', { event_id: ev.id }), err => err.code === 'EVENT_STATE');
  await run('event.pause', { event_id: ev.id, note: 'holiday' });
  await assert.rejects(run('event.pause', { event_id: ev.id }), err => err.code === 'EVENT_STATE');
  await run('event.resume', { event_id: ev.id });
  await run('event.cancel', { event_id: ev.id });
  for (const a of ['event.pause', 'event.resume', 'event.cancel']) {
    await assert.rejects(run(a, { event_id: ev.id }), err => err.code === 'EVENT_STATE', a);
  }
  await assert.rejects(run('event.update', { event_id: ev.id, title: 'again' }), err => err.code === 'EVENT_STATE');
  const h = await history(ev.id);
  for (const t of ['event.paused', 'event.resumed', 'event.cancelled']) assert.ok(h.includes(t), t);
});

test('event.update: reschedule bumps version and records from → to; a title change does not', async () => {
  const ev = await create({ title: 'reschedule me' });
  const r = await run('event.update', { event_id: ev.id, schedule: { kind: 'every', every: '2w', start_local: `${nextMonday()}T10:30` } });
  assert.equal(r.data.event.context.schedule_version, 2);
  assert.equal(r.data.event.context.schedule.every, '2w');
  const { data } = await run('artifact.get', { artifact_id: ev.id });
  const resched = data.events.find(e => e.event_type === 'event.rescheduled');
  const p = typeof resched.payload === 'string' ? JSON.parse(resched.payload) : resched.payload;
  assert.equal(p.from.version, 1);
  assert.equal(p.from.schedule.every, '1w');
  assert.equal(p.to.version, 2);

  const renamed = await run('event.update', { event_id: ev.id, title: 'renamed' });
  assert.equal(renamed.data.event.context.schedule_version, 2);

  // Changing only the timezone keeps the wall-clock time and is a reschedule.
  const moved = await run('event.update', { event_id: ev.id, timezone: 'America/New_York' });
  const c = moved.data.event.context;
  assert.equal(c.schedule_version, 3);
  assert.equal(S.localString(Date.parse(c.schedule.start_at), 'America/New_York').slice(11), '10:30');
});

test('plain (unscheduled) events stay valid and can be scheduled later', async () => {
  const plain = (await run('artifact.create', { artifact_type: 'event', title: 'Market day', ark_id: project.id })).data.artifact;
  assert.ok(!(await run('event.list', { project_id: project.id })).data.events.some(e => e.id === plain.id));
  await assert.rejects(run('event.pause', { event_id: plain.id }), err => err.code === 'EVENT_UNSCHEDULED');
  await assert.rejects(run('event.update', { event_id: plain.id, schedule: { kind: 'once', start_local: '2030-06-01T09:00' } }),
    err => err.code === 'BAD_TIMEZONE');
  await assert.rejects(run('event.update', { event_id: plain.id, timezone: LA, schedule: { kind: 'once', start_local: '2030-06-01T09:00' } }),
    err => err.code === 'BAD_EVENT_TYPE');
  const r = await run('event.update', { event_id: plain.id, event_type: 'market.pop_up', timezone: LA, schedule: { kind: 'once', start_local: '2030-06-01T09:00' } });
  assert.deepEqual([r.data.event.context.state, r.data.event.context.schedule_version], ['active', 1]);
});

test('artifact.create / artifact.update cannot write an event\'s schedule or state', async () => {
  await assert.rejects(run('artifact.create', { artifact_type: 'event', title: 'x', context: { schedule: { kind: 'once', start_at: '2030-01-01T00:00Z' } } }),
    err => err.status === 409 && err.code === 'EVENT_SCHEDULE');
  const ev = await create({ title: 'guarded' });
  for (const context of [{ state: 'paused' }, { schedule: { kind: 'once', start_at: '2031-01-01T00:00Z' } }, { schedule_version: 9 }, { timezone: 'UTC' }]) {
    await assert.rejects(run('artifact.update', { artifact_id: ev.id, context }), err => err.code === 'EVENT_SCHEDULE', JSON.stringify(context));
  }
  await run('artifact.update', { artifact_id: ev.id, context: { colour: 'blue' }, summary: 'ok' });
  assert.equal((await Artifact.findById(ev.id, ADMIN)).get('context').colour, 'blue');
  await assert.rejects(run('artifact.update', { artifact_id: ev.id, artifact_type: 'note' }), err => err.code === 'EVENT_SCHEDULE');

  const staged = (await run('artifact.create', { artifact_type: 'note', title: 's', context: { timezone: 'UTC' } })).data.artifact;
  await assert.rejects(run('artifact.update', { artifact_id: staged.id, artifact_type: 'event' }), err => err.code === 'EVENT_SCHEDULE');
});
