'use strict';

// Task lifecycle through dispatch() on a throwaway sqlite vessel:
// proposed ──task.approve──▶ ready ──task.complete──▶ resolved

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-tasks-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'tasks.sqlite') } });
});

const propose = async (title = 'do the thing') => (await run('task.propose', { title, description: 'why' })).data.task;
const ctxOf   = async id => (await Artifact.findById(id, ADMIN)).get('context');
const events  = async id => (await run('artifact.get', { artifact_id: id })).data.events.map(e => e.event_type);

test('task.approve: proposed → ready, records who/when/note, emits task.approved', async () => {
  const t = await propose();
  const r = await run('task.approve', { task_id: t.id, note: '  ship it  ' });
  const c = r.data.task.context;
  assert.equal(c.state, 'ready');
  assert.equal(c.approved.by, 'actor-admin');
  assert.equal(c.approved.note, 'ship it');
  assert.ok(Date.parse(c.approved.at));
  assert.ok((await events(t.id)).includes('task.approved'));

  await assert.rejects(run('task.approve', { task_id: t.id }), err => err.status === 409 && err.code === 'TASK_STATE');
});

test('task.complete: ready → resolved with evidence relations; wrong states refused', async () => {
  const t = await propose('needs evidence');
  await assert.rejects(run('task.complete', { task_id: t.id }), err => err.code === 'TASK_STATE' && /proposed/.test(err.message));
  await run('task.approve', { task_id: t.id });

  const proof = (await run('artifact.create', { artifact_type: 'note', title: 'proof' })).data.artifact;
  await assert.rejects(run('task.complete', { task_id: t.id, artifacts: ['00000000-0000-0000-0000-000000000000'] }),
    err => err.status === 404 && err.code === 'EVIDENCE_NOT_FOUND');
  assert.equal((await ctxOf(t.id)).state, 'ready', 'a failed completion changes nothing');

  const r = await run('task.complete', { task_id: t.id, note: 'done', artifacts: [proof.id] });
  const c = r.data.task.context;
  assert.equal(c.state, 'resolved');
  assert.deepEqual(c.completed.evidence, { note: 'done', artifacts: [proof.id] });
  assert.equal(c.approved.by, 'actor-admin', 'approval record is kept');

  const { data: rels } = await Artifact.db.from('artifact_relations').select('target_artifact_id')
    .eq('source_artifact_id', t.id).eq('relation_type', 'evidence');
  assert.deepEqual(rels.map(x => x.target_artifact_id), [proof.id]);
  assert.ok((await events(t.id)).includes('task.completed'));

  await assert.rejects(run('task.complete', { task_id: t.id }), err => err.code === 'TASK_STATE');
});

test('task.approve/complete: rank 100 only, even when the task is visible', async () => {
  const t = await propose('visible to all');
  const a = await Artifact.findById(t.id, ADMIN);
  a.assign({ context: { ...a.get('context'), visibility: 'public' } });
  await a.save();
  await assert.rejects(run('task.approve', { task_id: t.id }, USER), err => err.code === 'CAPABILITY_DENIED' && err.required === 'task.approve');
  await run('task.approve', { task_id: t.id });
  await assert.rejects(run('task.complete', { task_id: t.id }, USER), err => err.code === 'CAPABILITY_DENIED' && err.required === 'task.complete');
});

test('task lifecycle: workflow-shaped tasks (no state) can be neither approved nor completed', async () => {
  const t = (await run('workflow.start', { workflow_key: 'w', tasks: [{ title: 'workflow step', action: 'artifact.list' }] })).data.active_task;
  await assert.rejects(run('task.approve', { task_id: t.id }), err => err.code === 'TASK_STATE' && /unstated/.test(err.message));
  await assert.rejects(run('task.complete', { task_id: t.id }), err => err.code === 'TASK_STATE');
});

test('artifact.update: cannot move a task\'s lifecycle, can edit everything else', async () => {
  const t = await propose('guarded');
  for (const patch of [{ state: 'ready' }, { approved: { by: 'me' } }, { completed: { by: 'me' } }]) {
    await assert.rejects(run('artifact.update', { artifact_id: t.id, context: patch }),
      err => err.status === 409 && err.code === 'TASK_LIFECYCLE');
  }
  assert.equal((await ctxOf(t.id)).state, 'proposed');

  await run('artifact.update', { artifact_id: t.id, context: { state: 'proposed', priority: 'high' } });
  assert.equal((await ctxOf(t.id)).priority, 'high', 're-sending the current state is fine');

  const note = (await run('artifact.create', { artifact_type: 'note', title: 'n' })).data.artifact;
  await run('artifact.update', { artifact_id: note.id, context: { state: 'whatever' } });
  assert.equal((await ctxOf(note.id)).state, 'whatever', 'only tasks are guarded');
});

test('artifact.create: every new task starts proposed — ready/resolved can only be reached through the actions', async () => {
  const plain = (await run('artifact.create', { artifact_type: 'task', title: 'by hand', context: { kind: 'chore' } })).data.artifact;
  const c = await ctxOf(plain.id);
  assert.equal(c.state, 'proposed');
  assert.equal(c.kind, 'chore');
  assert.equal(c.proposed_by.actor, 'actor-admin');

  const explicit = (await run('artifact.create', { artifact_type: 'task', title: 'explicit', context: { state: 'proposed' } })).data.artifact;
  assert.equal((await ctxOf(explicit.id)).state, 'proposed');

  for (const context of [{ state: 'ready' }, { state: 'resolved' }, { approved: { by: 'me' } }, { completed: { by: 'me' } }]) {
    await assert.rejects(run('artifact.create', { artifact_type: 'task', title: 'skip', context }),
      err => err.status === 409 && err.code === 'TASK_LIFECYCLE', JSON.stringify(context));
  }

  const forged = (await run('artifact.create', { artifact_type: 'task', title: 'forged', context: { proposed_by: { actor: 'someone-else' } } })).data.artifact;
  assert.equal((await ctxOf(forged.id)).proposed_by.actor, 'actor-admin', 'proposer is the actor, not the payload');

  await run('task.approve', { task_id: plain.id });
  assert.equal((await run('task.complete', { task_id: plain.id })).data.task.context.state, 'resolved');
});

test('artifact.update: turning an artifact into a task enters the lifecycle as proposed', async () => {
  const note = (await run('artifact.create', { artifact_type: 'note', title: 'becomes a task', context: { priority: 'low' } })).data.artifact;
  await run('artifact.update', { artifact_id: note.id, artifact_type: 'task' });
  const c = await ctxOf(note.id);
  assert.equal(c.state, 'proposed');
  assert.equal(c.priority, 'low', 'existing context is kept');

  const sneaky = (await run('artifact.create', { artifact_type: 'note', title: 'pre-staged', context: { state: 'ready' } })).data.artifact;
  await assert.rejects(run('artifact.update', { artifact_id: sneaky.id, artifact_type: 'task' }),
    err => err.code === 'TASK_LIFECYCLE');
  await assert.rejects(run('artifact.update', { artifact_id: note.id, artifact_type: 'task', context: { state: 'ready' } }),
    err => err.code === 'TASK_LIFECYCLE', 'already a task: the update guard applies');
});
