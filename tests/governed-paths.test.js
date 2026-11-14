'use strict';

// End-to-end through dispatch() on a throwaway local sqlite vessel: the
// governed read paths and workflow.complete_task's re-entry into dispatch.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-governed-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const OTHER_STORE_ADMIN = { ...ADMIN, ark_actor_id: 'actor-other', store_id: 2 };

const run = (ctx, action, payload = {}) => dispatch({ action, payload }, ctx);
const insert = async (table, row) => {
  const { error } = await Artifact.db.from(table).insert({ id: crypto.randomUUID(), ...row });
  if (error) throw new Error(error.message);
};

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'governed.sqlite') } });
});

// ── workflow.complete_task ───────────────────────────────────────────────────

test('workflow.complete_task: task action is capability-checked as its own dispatch', async () => {
  // A USER may start a workflow and complete its tasks, but task.propose
  // needs rank 100. Before the fix the handler ran directly and succeeded.
  const started = await run(USER, 'workflow.start', {
    workflow_key: 'escalation-probe',
    tasks: [{ title: 'sneak', action: 'task.propose', payload: { title: 'x', body: 'y' } }],
  });
  const { workflow, active_task } = started.data;

  // workflow.start writes no visibility, so today only rank 100 can even load
  // a workflow — that incidental gate is what currently hides the bypass.
  // Make both public to exercise the capability check on its own.
  for (const id of [workflow.id, active_task.id]) {
    const a = await Artifact.findById(id, ADMIN);
    a.assign({ context: { ...a.get('context'), visibility: 'public' } });
    await a.save();
  }

  await assert.rejects(
    run(USER, 'workflow.complete_task', { workflow_id: workflow.id, task_id: active_task.id }),
    err => err.code === 'CAPABILITY_DENIED' && err.required === 'task.propose',
  );

  const task = await Artifact.findById(active_task.id, ADMIN);
  assert.notEqual(task.get('context').completed, true, 'a denied task stays incomplete');
});

test('workflow.complete_task: an authorized task action runs and advances the workflow', async () => {
  const started = await run(ADMIN, 'workflow.start', {
    workflow_key: 'happy-path',
    tasks: [
      { title: 'make', action: 'artifact.create', payload: { artifact_type: 'note', title: 'from workflow' } },
      { title: 'read', action: 'artifact.list',   payload: { artifact_type: 'note' } },
    ],
  });
  const { workflow, active_task } = started.data;

  const r = await run(ADMIN, 'workflow.complete_task', { workflow_id: workflow.id, task_id: active_task.id });
  assert.equal(r.data.is_completed, false);
  assert.ok(r.data.next_task, 'second task becomes active');
  assert.ok(r.log.some(l => l.includes('[artifact.create] ok')), 'inner dispatch log is surfaced');

  const notes = await Artifact.query({ artifact_type: 'note' }, ADMIN);
  assert.ok(notes.some(n => n.title === 'from workflow'));
});

// ── artifact.events.list ─────────────────────────────────────────────────────

test('artifact.events.list: gated by the artifact\'s own visibility, paginated', async () => {
  const priv = new Artifact({ artifact_type: 'note', title: 'private', context: { visibility: 'private' } }, { context: ADMIN });
  await priv.save();
  for (let i = 0; i < 3; i++) {
    await insert('artifact_events', {
      store_id: 1, artifact_id: priv.id, event_type: 'test', event_name: `e${i}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }

  await assert.rejects(run(USER, 'artifact.events.list', { artifact_id: priv.id }), err => err.status === 404);
  await assert.rejects(run(OTHER_STORE_ADMIN, 'artifact.events.list', { artifact_id: priv.id }), err => err.status === 404);

  const page1 = await run(ADMIN, 'artifact.events.list', { artifact_id: priv.id, limit: 2 });
  assert.deepEqual(page1.data.events.map(e => e.event_name), ['e2', 'e1']);
  assert.ok(page1.data.next_before);

  const page2 = await run(ADMIN, 'artifact.events.list', { artifact_id: priv.id, limit: 2, before: page1.data.next_before });
  assert.deepEqual(page2.data.events.map(e => e.event_name), ['e0']);
  assert.equal(page2.data.next_before, null);
});

// ── template.list ────────────────────────────────────────────────────────────

test('template.list: works on sqlite — global + own store, never another store; ark_type filter', async () => {
  const tpl = (title, store_id, ark_type) => insert('artifacts', {
    artifact_type: 'template', status: 'published', inactive: 0, title, store_id,
    metadata: JSON.stringify({ ark_type }),
  });
  await tpl('B global',      null, 'journal');
  await tpl('A own store',   1,    'gallery');
  await tpl('C other store', 2,    'journal');

  const all = await run(USER, 'template.list');
  assert.deepEqual(all.data.templates.map(t => t.title), ['A own store', 'B global']);

  const journals = await run(USER, 'template.list', { ark_type: 'journal' });
  assert.deepEqual(journals.data.templates.map(t => t.title), ['B global']);
});

// ── ark.list domain_id ───────────────────────────────────────────────────────

test('ark.list: domain_id filter narrows to one domain', async () => {
  const ark = (title, domain_id) => insert('artifacts', {
    artifact_type: 'ark', status: 'published', inactive: 0, title, store_id: 1, domain_id,
    context: JSON.stringify({ visibility: 'public' }),
  });
  await ark('dev project',  'domain-developer');
  await ark('farm project', 'domain-farm');

  const dev = await run(ADMIN, 'ark.list', { domain_id: 'domain-developer' });
  assert.deepEqual(dev.data.arks.map(a => a.title), ['dev project']);

  const both = await run(ADMIN, 'ark.list');
  assert.ok(['dev project', 'farm project'].every(t => both.data.arks.some(a => a.title === t)));
});
