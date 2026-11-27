'use strict';

// Lamb Mode: a durable, owner-only quiet setting checked at dispatch().

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');
const ChainExecutor = require('../core/ChainExecutor');
const HarnessActions = require('../actions/HarnessActions');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-lamb-test-'));
const DB = path.join(TMP, 'lamb.sqlite');
const OWNER = { ark_actor_id: 'actor-owner', store_id: 1, role: 'ADMIN', rank: 100, source: 'cli' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'cli' };
const AGENT = { ...OWNER, source: 'harness', delegation: { via: 'harness', task_id: 't', run_key: 'k' } };
const CYCLE = { ...OWNER, source: 'system.cycle' };
const run = (action, payload = {}, ctx = OWNER, meta = {}) => dispatch({ action, payload, meta }, ctx);
const lamb = err => err.status === 423 && err.code === 'LAMB_MODE';
const HOUR = 3600000;
const SLOW = path.join(TMP, 'slow');

async function boot() {
  _reset();
  const bin = path.join(TMP, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const done = () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'report', total_cost_usd: 0, num_turns: 1, modelUsage: {} }));
  if (require('fs').existsSync(${JSON.stringify(SLOW)})) setTimeout(done, 30000); else done();
});`);
  fs.chmodSync(bin, 0o755);
  await bootstrap({ db: { driver: 'sqlite', path: DB }, harness: { drivers: [{ name: 'claude', kind: 'claude-code', bin }], allowed_roots: [TMP] } });
}

function repo() {
  const dir = path.join(TMP, 'repo');
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q'); fs.writeFileSync(path.join(dir, 'a.js'), 'a\n'); g('add', '.'); g('commit', '-qm', 'init');
  return dir;
}

async function readyTask(title, ctx = OWNER) {
  const t = (await run('task.propose', { title, inputs: { repositories: [{ alias: 'r', path: repo() }] }, required_capabilities: ['repo.read'] }, ctx)).data.task;
  await run('task.approve', { task_id: t.id }, ctx);
  return t;
}

async function hourlyEvent(title, ctx = OWNER) {
  const ev = (await run('event.create', { title, event_type: 'dev.check', timezone: 'UTC', schedule: { kind: 'every', every: '1h', start_at: new Date(Date.now() - 3 * HOUR - 60000).toISOString() } }, ctx)).data.event;
  const e = await Artifact.findById(ev.id, ctx);
  await Artifact.db.from('artifacts').update({ context: { ...e.get('context'), active_since: new Date(Date.now() - 4 * HOUR).toISOString() } }).eq('id', ev.id);
  return ev;
}
const fired = (r, id) => r.data.results.filter(x => x.event_id === id);

before(boot);
after(() => { _reset(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('only the owner, acting directly, reads or changes the mode — never an agent or a cycle', async () => {
  assert.equal((await run('vessel.mode')).data.mode, 'normal');
  await assert.rejects(run('vessel.mode', {}, USER), err => err.code === 'CAPABILITY_DENIED');
  await assert.rejects(run('vessel.quiet', {}, USER), err => err.code === 'CAPABILITY_DENIED');
  for (const ctx of [AGENT, CYCLE, { ...OWNER, source: 'resume' }]) {
    await assert.rejects(run('vessel.quiet', {}, ctx), err => err.code === 'OWNER_ONLY', ctx.source);
  }
  assert.equal((await run('vessel.mode')).data.mode, 'normal');
});

test('quiet survives a restart; only vessel.resume ends it', async () => {
  const q = (await run('vessel.quiet', { note: 'travelling' })).data;
  assert.equal(q.mode, 'lamb');
  await assert.rejects(run('vessel.quiet'), err => err.code === 'ALREADY_QUIET');
  await boot(); // a new process on the same vessel
  const m = (await run('vessel.mode')).data;
  assert.deepEqual([m.mode, m.note, m.by], ['lamb', 'travelling', 'actor-owner']);
  await assert.rejects(run('vessel.resume', {}, AGENT), err => err.code === 'OWNER_ONLY');
  await run('vessel.resume');
  assert.equal((await run('vessel.mode')).data.mode, 'normal');
  await assert.rejects(run('vessel.resume'), err => err.code === 'NOT_QUIET');
});

test('ordinary artifact and ark actions cannot create, alter, or archive vessel mode', async () => {
  const protectedMode = err => err.code === 'VESSEL_MODE_PROTECTED';
  await assert.rejects(run('artifact.create', { artifact_type: 'vessel_mode', slug: 'vessel-mode', title: 'fake' }, USER), protectedMode);
  const q = (await run('vessel.quiet')).data;
  const m = await require('../utils/vesselMode').current(OWNER.store_id);
  try {
    await assert.rejects(run('artifact.update', { artifact_id: m.id, context: { mode: 'normal' } }), protectedMode);
    await assert.rejects(run('artifact.archive', { artifact_id: m.id }), protectedMode);
    await assert.rejects(run('ark.update', { ark_id: m.id, context: { mode: 'normal' } }), protectedMode);
    await assert.rejects(run('ark.archive', { ark_id: m.id }), protectedMode);
    const note = (await run('artifact.create', { artifact_type: 'note', title: 'ordinary' })).data.artifact;
    await assert.rejects(run('artifact.update', { artifact_id: note.id, artifact_type: 'vessel_mode' }), protectedMode);
    assert.equal(q.mode, 'lamb');
    assert.equal((await run('vessel.mode')).data.mode, 'lamb');
  } finally {
    await run('vessel.resume');
  }
});

test('concurrent first quiet requests create only one mode record', async () => {
  const other = { ...OWNER, store_id: 3, ark_actor_id: 'third-owner' };
  const results = await Promise.allSettled([run('vessel.quiet', {}, other), run('vessel.quiet', {}, other)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const rows = await Artifact.query({ artifact_type: 'vessel_mode' }, other);
  assert.equal(rows.length, 1);
  assert.equal((await run('vessel.mode', {}, other)).data.mode, 'lamb');
  await run('vessel.resume', {}, other);
});

test('concurrent resume requests cannot both change the mode', async () => {
  await run('vessel.quiet');
  const results = await Promise.allSettled([run('vessel.resume'), run('vessel.resume')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal((await run('vessel.mode')).data.mode, 'normal');
});

test('a losing skip resume does not change event schedules or the winning cutoff', async () => {
  const other = { ...OWNER, store_id: 4, ark_actor_id: 'fourth-owner' };
  const event = await hourlyEvent('concurrent resume', other);
  const before = (await Artifact.findById(event.id, other)).get('context').active_since;
  await run('vessel.quiet', {}, other);
  const results = await Promise.allSettled([
    run('vessel.resume', { missed: 'latest' }, other),
    run('vessel.resume', { missed: 'skip' }, other),
  ]);
  const winners = results.filter(r => r.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const mode = await require('../utils/vesselMode').current(other.store_id);
  assert.equal((await Artifact.findById(event.id, other)).get('context').active_since, before);
  assert.equal(!!mode.skip_before, winners[0].value.data.missed === 'skip');
  const due = fired(await run('system.cycle', { dry_run: true }, other), event.id);
  assert.equal(due.length, winners[0].value.data.missed === 'skip' ? 0 : 1);
});

test('sync refuses vessel mode records and remote mode targets', async () => {
  const { _assertNoVesselMode } = require('../actions/SyncActions')._internals;
  const remote = rows => ({ from: () => ({ select: () => ({ in: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }) });
  const protectedMode = err => err.code === 'VESSEL_MODE_PROTECTED';
  await assert.rejects(_assertNoVesselMode([{ id: 'a', artifact_type: 'vessel_mode' }], remote([]), 1), protectedMode);
  await assert.rejects(_assertNoVesselMode([{ id: 'a', artifact_type: 'note' }], remote([{ id: 'a' }]), 1), protectedMode);
  await assert.rejects(_assertNoVesselMode([{ id: require('../utils/vesselMode').idForStore(1), artifact_type: 'note' }], remote([]), 1), protectedMode);
  await assert.doesNotReject(_assertNoVesselMode([{ id: 'a', artifact_type: 'note' }], remote([]), 1));
});

test('while quiet: the cycle claims nothing; work is held unless the owner overrides; intent and reads still work', async () => {
  const ev = await hourlyEvent('quiet hourly');
  const task = await readyTask('quiet review');
  await run('vessel.quiet');
  try {
    const c = await run('system.cycle', { wait: true });
    assert.equal(c.data.quiet, true);
    assert.equal(fired(c, ev.id).length, 0);
    assert.equal(fired(await run('system.cycle', { dry_run: true }), ev.id).length, 1, 'a dry run still previews');

    // work: held, overridable — but only by the owner in the foreground.
    await assert.rejects(run('harness.run', { task_id: task.id }), err => lamb(err) && err.overridable === true);
    await assert.rejects(run('harness.run', { task_id: task.id }, CYCLE, { quiet_override: true }), lamb, 'a cycle can\'t override');
    await assert.rejects(run('harness.run', { task_id: task.id }, AGENT, { quiet_override: true }), lamb, 'an agent can\'t override');
    await assert.rejects(run('harness.run', { task_id: task.id }, OWNER, { quiet_override: 'yes' }), lamb, 'only an explicit true');
    const anyway = await run('harness.run', { task_id: task.id }, OWNER, { quiet_override: true });
    assert.ok(anyway.data.review.id, 'the owner ran it anyway');
    const overrideLedger = (await run('ledger.get', { ledger_id: anyway.meta.ledger_id })).data.ledger;
    assert.equal(overrideLedger.provenance.quiet_override_requested, true);

    // background: an agent's writes and automated workflow steps, never overridable.
    await assert.rejects(run('task.propose', { title: 'from an agent' }, AGENT), err => lamb(err) && err.overridable === false);
    await assert.rejects(run('artifact.create', { artifact_type: 'note', title: 'step' }, OWNER, { workflow_run: 'r1', quiet_override: true }), lamb);
    assert.ok((await run('artifact.list', { artifact_type: 'note' }, AGENT)).data, 'an agent can still read (a run finishing)');

    // intent is recorded, nothing runs.
    assert.equal((await run('task.propose', { title: 'later' })).data.task.context.state, 'proposed');
    assert.ok((await run('approval.queue')).data);

    // Refusals are ledgered like any other failure.
    const ledger = (await run('ledger.list', { limit: 50 })).data.ledger;
    assert.ok(ledger.some(l => l.action === 'harness.run' && l.status !== 'closed'), JSON.stringify(ledger.slice(0, 5).map(l => [l.action, l.status])));
  } finally {
    await run('vessel.resume');
  }
});

test('resume: latest fires each event\'s missed occurrence once; skip fires none; the preview shows only what will fire', async () => {
  const a = await hourlyEvent('missed latest');
  await run('vessel.quiet');
  await run('system.cycle', { wait: true });
  await run('vessel.resume', { missed: 'latest' });
  assert.equal(fired(await run('system.cycle', { wait: true }), a.id).length, 1);
  assert.equal(fired(await run('system.cycle', { dry_run: true }), a.id).length, 0, 'already fired: not previewed again');

  const b = await hourlyEvent('missed skip');
  await run('vessel.quiet');
  assert.equal(fired(await run('system.cycle', { dry_run: true }), b.id).length, 1, 'previewed before resume');
  const r = (await run('vessel.resume', { missed: 'skip' })).data;
  assert.ok(r.skipped >= 1);
  assert.equal(fired(await run('system.cycle', { wait: true }), b.id).length, 0);
  const hist = (await run('artifact.get', { artifact_id: b.id })).data.events.map(e => e.event_type);
  assert.ok(hist.includes('event.missed_skipped'));
  await boot();
  await run('vessel.quiet');
  await run('vessel.resume', { missed: 'latest' });
  assert.equal(fired(await run('system.cycle', { dry_run: true }), b.id).length, 0, 'later transitions retain the cutoff');
  await assert.rejects(run('vessel.resume', { missed: 'sometimes' }), err => err.code === 'BAD_MISSED' || err.code === 'NOT_QUIET');
});

test('quiet with cancel_running stops agent runs in flight; their task stays approved', async () => {
  const task = await readyTask('long review');
  fs.writeFileSync(SLOW, '');
  try {
    const p = assert.rejects(run('harness.run', { task_id: task.id }), err => err.code === 'CANCELLED');
    for (let i = 0; i < 100 && HarnessActions.running() === 0; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(HarnessActions.running(), 1);
    const q = (await run('vessel.quiet', { cancel_running: true })).data;
    assert.equal(q.cancelled, 1);
    await p;
    const c = (await Artifact.findById(task.id, OWNER)).get('context');
    assert.equal(c.state, 'ready');
    assert.equal(c.last_attempt.status, 'cancelled');
  } finally {
    fs.rmSync(SLOW, { force: true });
    await run('vessel.resume', { missed: 'skip' }).catch(() => {});
  }
});

test('quiet only counts and cancels runs in its own store', async () => {
  const other = { ...OWNER, store_id: 2, ark_actor_id: 'other-owner' };
  const one = await readyTask('first store run');
  const two = await readyTask('second store run', other);
  fs.writeFileSync(SLOW, '');
  const first = assert.rejects(run('harness.run', { task_id: one.id }), err => err.code === 'CANCELLED');
  const second = assert.rejects(run('harness.run', { task_id: two.id }, other), err => err.code === 'CANCELLED');
  try {
    for (let i = 0; i < 100 && HarnessActions.running() < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(HarnessActions.running(), 2);
    assert.equal((await run('vessel.mode')).data.running.harness, 1);
    const q = (await run('vessel.quiet', { cancel_running: true })).data;
    assert.equal(q.cancelled, 1);
    await first;
    assert.equal(HarnessActions.running(other.store_id), 1);
  } finally {
    await run('harness.cancel', { task_id: two.id }, other);
    await second;
    fs.rmSync(SLOW, { force: true });
    await run('vessel.resume', { missed: 'skip' });
  }
});

test('ChainExecutor.resume leaves a quiet vessel\'s chains pending, and resumes them after', async () => {
  let calls = 0;
  const registry = { 'test.noop': { handler: async () => { calls++; return { data: {} }; } } };
  const id = crypto.randomUUID();
  await Artifact.db.from('artifact_chains').insert({ id, store_id: '1', principal_id: 'actor-owner', action: 'test.noop', status: 'pending', context: {} });
  await Artifact.db.from('artifact_chain_steps').insert({ id: crypto.randomUUID(), chain_id: id, step_index: 0, action: 'test.noop', status: 'pending', input: {} });

  await run('vessel.quiet');
  await ChainExecutor.resume(registry);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(calls, 0, 'held while quiet');

  await run('vessel.resume', { missed: 'skip' });
  await ChainExecutor.resume(registry);
  for (let i = 0; i < 40 && !calls; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(calls, 1, 'resumed after');
});
