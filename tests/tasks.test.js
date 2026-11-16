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

const SCOPED = {
  inputs: { repositories: [{ alias: 'a', path: '/repos/a' }] },
  required_capabilities: ['repo.read'],
  execution_policy: { failover: true },
};
const proposeScoped = async title => (await run('artifact.create', { artifact_type: 'task', title, context: SCOPED })).data.artifact;

test('task.approve pins the scope hash; key order does not change it', async () => {
  const { scopeHash } = require('../utils/taskScope');
  const t = await proposeScoped('pinned');
  const c = (await run('task.approve', { task_id: t.id })).data.task.context;
  assert.equal(c.approved.scope_hash, scopeHash(c));
  assert.equal(scopeHash({ execution_policy: { failover: true }, required_capabilities: ['repo.read'], inputs: SCOPED.inputs, other: 1 }), c.approved.scope_hash,
    'only scope keys count, in any order');
});

test('artifact.update: an approved task\'s scope is locked; other context stays editable', async () => {
  const t = await proposeScoped('locked');
  await run('artifact.update', { artifact_id: t.id, context: { required_capabilities: ['repo.read', 'code.review'] } });
  assert.deepEqual((await ctxOf(t.id)).required_capabilities, ['repo.read', 'code.review'], 'a proposed task is still draft');

  await run('task.approve', { task_id: t.id });
  for (const patch of [
    { inputs: { repositories: [{ alias: 'b', path: '/repos/b' }] } },
    { required_capabilities: ['repo.read', 'artifact.read', 'task.propose'] },
    { constraints: { filesystem: 'read_write' } },
    { execution_policy: { driver: 'claude' } },
  ]) {
    await assert.rejects(run('artifact.update', { artifact_id: t.id, context: patch }),
      err => err.status === 409 && err.code === 'TASK_SCOPE_LOCKED', JSON.stringify(patch));
  }
  await run('artifact.update', { artifact_id: t.id, context: { priority: 'high', required_capabilities: ['repo.read', 'code.review'] } });
  const c = await ctxOf(t.id);
  assert.equal(c.priority, 'high', 'non-scope edits and re-sent scope values are fine');
  assert.equal(c.state, 'ready');

  await run('task.complete', { task_id: t.id });
  await assert.rejects(run('artifact.update', { artifact_id: t.id, context: { execution_policy: { model: 'x' } } }),
    err => err.code === 'TASK_SCOPE_LOCKED', 'resolved tasks re-run, so they stay locked');
});

test('task.revise: changes the scope and sends the task back to proposed, keeping the old approval in the event', async () => {
  const t = await proposeScoped('revised');
  await run('task.approve', { task_id: t.id, note: 'first' });
  await run('task.complete', { task_id: t.id, note: 'done' });

  const r = await run('task.revise', { task_id: t.id, changes: { execution_policy: { failover: false }, constraints: null }, note: 'no failover' });
  assert.deepEqual(r.data.changed, ['execution_policy']);
  const c = await ctxOf(t.id);
  assert.equal(c.state, 'proposed');
  assert.equal(c.approved, undefined);
  assert.equal(c.completed, undefined);
  assert.deepEqual(c.execution_policy, { failover: false });
  assert.deepEqual(c.inputs, SCOPED.inputs, 'keys not named are kept');

  const ev = (await run('artifact.get', { artifact_id: t.id })).data.events.find(e => e.event_type === 'task.revised');
  assert.equal(ev.payload.from, 'resolved');
  assert.equal(ev.payload.previous.approved.note, 'first');
  assert.equal(ev.payload.previous.completed.evidence.note, 'done');
  assert.equal(ev.payload.note, 'no failover');

  const again = (await run('task.approve', { task_id: t.id })).data.task.context;
  assert.equal(again.state, 'ready', 'the new scope is approved on its own');
});

test('task.revise: refuses no-ops, non-scope keys, bad shapes, unstated tasks and non-admins', async () => {
  const t = await proposeScoped('picky');
  await run('task.approve', { task_id: t.id });
  const bad = async (payload, code, ctx) => assert.rejects(run('task.revise', { task_id: t.id, ...payload }, ctx), err => err.code === code, JSON.stringify(payload));
  await bad({ changes: { execution_policy: { failover: true } } }, 'NO_CHANGE');
  await bad({ changes: { state: 'ready' } }, 'BAD_CHANGES');
  await bad({ changes: { required_capabilities: 'repo.read' } }, 'BAD_CHANGES');
  await bad({ changes: [] }, 'BAD_CHANGES');
  await bad({ changes: { constraints: {} } }, 'CAPABILITY_DENIED', USER);
  assert.equal((await ctxOf(t.id)).state, 'ready', 'refusals change nothing');

  const wf = (await run('workflow.start', { workflow_key: 'w2', tasks: [{ title: 'step', action: 'artifact.list' }] })).data.active_task;
  await assert.rejects(run('task.revise', { task_id: wf.id, changes: { constraints: {} } }), err => err.code === 'TASK_STATE');
});

const PR = { repository: { alias: 'ark', path: '/repos/ark' }, base: 'main', branch: 'ark/fix-gateway', body: '- **high** token compare (ark:cli/gateway.js:88)' };

test('PR intent: task.propose kind pr — inputs and capabilities come from the PR, linked to its review and project', async () => {
  const project = (await run('ark.create', { title: 'PR project' })).data.ark;
  const review = (await run('artifact.create', { artifact_type: 'review', title: 'Review: gateway' })).data.artifact;
  const r = await run('task.propose', {
    kind: 'pr', title: 'Fix gateway token compare', description: 'from the review', pr: PR,
    derived_from: review.id, project_id: project.id,
    required_capabilities: ['repo.read', 'artifact.read'], execution_policy: { drivers: ['claude'] }, inputs: { repositories: [] },
  });
  const c = r.data.task.context;
  assert.equal(c.kind, 'pr');
  assert.equal(c.state, 'proposed');
  assert.deepEqual(c.inputs, { pr: PR }, 'inputs are the PR — caller inputs are ignored');
  assert.deepEqual(c.required_capabilities, ['repo.write'], 'caller capabilities are ignored');
  assert.equal(c.execution_policy, undefined, 'a PR intent has no driver policy');
  assert.equal(c.derived_from, review.id);
  const { data: rels } = await Artifact.db.from('artifact_relations').select('source_artifact_id, relation_type')
    .eq('target_artifact_id', r.data.task.id);
  assert.ok(rels.some(x => x.source_artifact_id === project.id && x.relation_type === 'contains'));

  const minimal = (await run('task.propose', { kind: 'pr', title: 'min', pr: { repository: PR.repository } })).data.task.context.inputs.pr;
  assert.deepEqual(minimal, { repository: PR.repository, base: 'main', body: '' }, 'base defaults to main');
});

test('PR intent: bad PR shapes are refused', async () => {
  for (const pr of [undefined, 'x', { base: 'main' }, { repository: { alias: 'a' } },
    { repository: PR.repository, base: '../etc' }, { repository: PR.repository, base: '/main' }, { repository: PR.repository, branch: 'has space' },
    { repository: PR.repository, branch: 'a..b' }, { repository: PR.repository, body: 'x'.repeat(20001) }]) {
    await assert.rejects(run('task.propose', { kind: 'pr', title: 'bad', pr }), err => err.status === 400 && err.code === 'BAD_PR', JSON.stringify(pr));
  }
});

test('PR intent: kind is normalized before it is checked — padding cannot skip PR validation', async () => {
  await assert.rejects(run('task.propose', { kind: ' pr ', title: 'padded', required_capabilities: ['repo.read'], inputs: { repositories: [] } }),
    err => err.status === 400 && err.code === 'BAD_PR', 'no pr payload → refused, same as kind "pr"');
  const c = (await run('task.propose', { kind: '\tpr\n', title: 'padded ok', pr: PR, required_capabilities: ['repo.read'] })).data.task.context;
  assert.equal(c.kind, 'pr');
  assert.deepEqual(c.required_capabilities, ['repo.write'], 'capabilities forced, as for kind "pr"');
  assert.deepEqual(c.inputs, { pr: PR });
  assert.equal((await run('task.propose', { kind: ' chore ', title: 'other kind' })).data.task.context.kind, 'chore');
});

test('PR intent: approvable, never executable; revising its PR keeps it valid', async () => {
  const t = (await run('task.propose', { kind: 'pr', title: 'Open me', pr: PR })).data.task;
  await run('task.approve', { task_id: t.id, note: 'go ahead' });
  for (const action of ['harness.run', 'harness.watch']) {
    await assert.rejects(run(action, { task_id: t.id }), err => err.status === 422 && err.code === 'PR_NOT_EXECUTABLE', action);
  }
  await assert.rejects(run('task.revise', { task_id: t.id, changes: { inputs: { pr: { ...PR, base: '..' } } } }), err => err.code === 'BAD_PR');
  await assert.rejects(run('task.revise', { task_id: t.id, changes: { inputs: {} } }), err => err.code === 'BAD_PR', 'the PR cannot be dropped');
  const r = await run('task.revise', { task_id: t.id, changes: { inputs: { pr: { ...PR, base: 'develop' } } } });
  assert.equal(r.data.task.context.state, 'proposed');
  assert.equal(r.data.task.context.inputs.pr.base, 'develop');
});

test('execution_policy shape: checked by task.revise and task.approve', async () => {
  const { policyError } = require('../utils/taskScope');
  for (const ok of [null, {}, { drivers: ['copilot', { name: 'claude', model: 'opus' }], model: 'm', failover: false }, { driver: 'claude' }]) {
    assert.equal(policyError(ok), null, JSON.stringify(ok));
  }
  for (const bad of [[], { driver_order: ['x'] }, { drivers: [] }, { drivers: ['a', 'a'] }, { drivers: ['a'], driver: 'a' },
    { drivers: [{ name: 'a', extra: 1 }] }, { drivers: [{ model: 'm' }] }, { failover: 'yes' }, { drivers: Array(9).fill(0).map((_, i) => `d${i}`) }]) {
    assert.ok(policyError(bad), JSON.stringify(bad));
  }

  const t = await proposeScoped('policy');
  await assert.rejects(run('task.revise', { task_id: t.id, changes: { execution_policy: { drivers: ['copilot', 'copilot'] } } }),
    err => err.status === 400 && err.code === 'BAD_POLICY');
  await run('task.revise', { task_id: t.id, changes: { execution_policy: { drivers: ['copilot', { name: 'claude', model: 'opus' }] } } });
  assert.equal((await run('task.approve', { task_id: t.id })).data.task.context.state, 'ready');

  const typo = (await run('artifact.create', { artifact_type: 'task', title: 'typo', context: { execution_policy: { driver_order: ['claude'] } } })).data.artifact;
  await assert.rejects(run('task.approve', { task_id: typo.id }), err => err.status === 422 && err.code === 'BAD_POLICY');
});

test('harness.run / harness.watch: refuse a task whose scope no longer matches its approval', async () => {
  const t = await proposeScoped('tampered');
  await run('task.approve', { task_id: t.id });
  // Around the actions — a direct write, as a sync or a DB edit would make.
  const a = await Artifact.findById(t.id, ADMIN);
  a.assign({ context: { ...a.get('context'), required_capabilities: ['repo.read', 'artifact.read'], inputs: { ...SCOPED.inputs, compare: { base: 'a', head: 'a' } } } });
  await a.save();
  for (const action of ['harness.run', 'harness.watch']) {
    await assert.rejects(run(action, { task_id: t.id }), err => err.status === 409 && err.code === 'TASK_SCOPE_CHANGED', action);
  }
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
