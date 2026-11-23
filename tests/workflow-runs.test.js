'use strict';

// Workflow runs: launch → approve once → steps become governed tasks as the
// run reaches them → each resolution moves it on.

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-runs-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
const inspect = async run_id => (await run('workflow.inspect', { run_id })).data;
const ctxOf = async id => { const c = (await Artifact.findById(id, ADMIN)).get('context'); return typeof c === 'string' ? JSON.parse(c) : c; };
const runEvents = async id => (await run('artifact.get', { artifact_id: id })).data.events.map(e => e.event_type).reverse();

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

before(async () => {
  _reset();
  const bin = path.join(TMP, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'review report', total_cost_usd: 0.1, num_turns: 1, modelUsage: {} }));
});`);
  fs.chmodSync(bin, 0o755);
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'runs.sqlite') }, harness: { drivers: [{ name: 'claude', kind: 'claude-code', bin }], allowed_roots: [TMP] } });
  await seedProjectTemplates(dispatch, ADMIN);
});
after(() => { _reset(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function project(title) {
  const p = (await run('ark.create', { title, template_id: 'project-developer' })).data.ark;
  await run('repository.add', { project_id: p.id, alias: 'site', path: repo(`${title.replace(/\W/g, '')}-site`) });
  return p;
}

test('code review end to end: launch → approve → ai review → triage → PR intent (gated) → completed', async () => {
  const p = await project('Code Review');
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'code-review', note: 'weekly' })).data.run;
  let v = await inspect(launched.id);
  assert.equal((await ctxOf(launched.id)).state, 'proposed');
  assert.deepEqual(v.steps.map(s => [s.key, s.state, s.task]), [['review', 'pending', null], ['triage', 'pending', null], ['pr', 'pending', null]]);
  const rc = await ctxOf(launched.id);
  assert.deepEqual({ alias: rc.definition.alias, revision: rc.definition.revision, from: rc.definition.from }, { alias: 'code-review', revision: 1, from: 'template' });

  await assert.rejects(run('workflow.launch', { project_id: p.id, alias: 'code-review' }, USER), err => err.code === 'CAPABILITY_DENIED');
  await assert.rejects(run('workflow.approve', { run_id: launched.id }, USER), err => err.code === 'CAPABILITY_DENIED');

  // Approve once: the plan and the ai step's scope are pinned; the first step starts, approved by the run.
  v = (await run('workflow.approve', { run_id: launched.id, note: 'go' })).data;
  const approved = (await ctxOf(launched.id)).approved;
  assert.match(approved.plan_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(approved.step_scopes), ['review']);
  assert.deepEqual(v.steps.map(s => [s.key, s.state]), [['review', 'ready'], ['triage', 'pending'], ['pr', 'pending']]);
  const review = await ctxOf(v.steps[0].task.id);
  assert.deepEqual({ state: review.state, via: review.approved.via, by: review.approved.by, mode: review.workflow_run.mode },
    { state: 'ready', via: { workflow_run: launched.id }, by: 'actor-admin', mode: 'ai' });
  assert.equal(review.inputs.project_repositories, 'all');
  await assert.rejects(run('workflow.approve', { run_id: launched.id }), err => err.code === 'RUN_NOT_PROPOSED');

  // The agent review succeeds → the step resolves with the review as evidence → triage starts.
  const r = await run('harness.run', { task_id: v.steps[0].task.id });
  const reviewed = await ctxOf(v.steps[0].task.id);
  assert.equal(reviewed.state, 'resolved');
  assert.deepEqual(reviewed.completed.evidence.artifacts, [r.data.review.id]);
  v = await inspect(launched.id);
  assert.deepEqual(v.steps.map(s => [s.key, s.state]), [['review', 'resolved'], ['triage', 'ready'], ['pr', 'pending']]);

  // A person completes triage → the PR step waits for an intent.
  await run('task.complete', { task_id: v.steps[1].task.id, note: 'fix the two criticals' });
  v = await inspect(launched.id);
  assert.deepEqual(v.steps.map(s => [s.key, s.state]), [['review', 'resolved'], ['triage', 'resolved'], ['pr', 'awaiting_input']]);

  // The PR intent proposed into the step is gated: its own approval, then completion.
  const pr = (await run('task.propose', {
    project_id: p.id, title: 'Fix criticals', kind: 'pr', workflow_step: { run_id: launched.id, step: 'pr' },
    pr: { repository: { alias: 'site', path: '/repos/site' }, base: 'main', body: 'Fixes the two criticals.' },
  })).data.task;
  assert.deepEqual(pr.context.workflow_run, { run_id: launched.id, step: 'pr', mode: 'human', gate: true });
  v = await inspect(launched.id);
  assert.deepEqual([v.steps[2].state, v.steps[2].task.id], ['proposed', pr.id]);
  await run('task.approve', { task_id: pr.id });
  await run('task.complete', { task_id: pr.id, note: 'PR opened by hand' });
  v = await inspect(launched.id);
  assert.equal((await ctxOf(launched.id)).state, 'completed');
  assert.deepEqual(v.steps.map(s => s.state), ['resolved', 'resolved', 'resolved']);

  assert.deepEqual((await runEvents(launched.id)).filter(t => t.startsWith('workflow.')), [
    'workflow.launched', 'workflow.approved',
    'workflow.step_started', 'workflow.step_resolved',
    'workflow.step_started', 'workflow.step_resolved',
    'workflow.step_waiting', 'workflow.step_started', 'workflow.step_resolved',
    'workflow.completed',
  ]);
});

test('the run follows its launch snapshot, not later edits to the definition', async () => {
  const p = await project('Snapshot');
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'two', title: 'Two', steps: [{ key: 'a', title: 'A', mode: 'human' }, { key: 'b', title: 'B', mode: 'human' }] })).data.workflow;
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'two' })).data.run;
  await run('workflow.redefine', { workflow_id: wf.id, changes: { steps: [{ key: 'only', title: 'Only', mode: 'human' }] } });
  const v = (await run('workflow.approve', { run_id: launched.id })).data;
  assert.deepEqual(v.steps.map(s => s.key), ['a', 'b']);
  assert.equal((await ctxOf(launched.id)).definition.revision, 1);
});

test('an ai step whose repositories changed after approval waits for a person', async () => {
  const p = await project('Drift');
  await run('workflow.define', { project_id: p.id, alias: 'prep-then-review', title: 'Prep then review', steps: [
    { key: 'prep', title: 'Prep', mode: 'human' }, { key: 'review', title: 'Review', mode: 'ai' }] });
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'prep-then-review' })).data.run;
  let v = (await run('workflow.approve', { run_id: launched.id })).data;
  await run('repository.add', { project_id: p.id, alias: 'ark', path: repo('drift-ark') }); // after the scope was pinned
  await run('task.complete', { task_id: v.steps[0].task.id });
  v = await inspect(launched.id);
  const step = v.steps[1];
  assert.deepEqual([step.state, step.blocked], ['proposed', 'scope_changed']);
  const t = await ctxOf(step.task.id);
  assert.equal(t.approved, undefined, 'not approved on the run\'s behalf');
  assert.ok((await runEvents(launched.id)).includes('workflow.step_blocked'));
  await run('task.approve', { task_id: step.task.id }); // a person approves the new scope
  assert.equal((await ctxOf(step.task.id)).state, 'ready');
});

test('gated steps wait for their own approval; automated steps run and resolve; failures stop the run until advanced', async () => {
  const p = await project('Steps');
  await run('workflow.define', { project_id: p.id, alias: 'mixed', title: 'Mixed', steps: [
    { key: 'note', title: 'Write a note', mode: 'automated', action: 'artifact.create', payload: { artifact_type: 'note', title: 'from a workflow' } },
    { key: 'check', title: 'Check it', mode: 'human', gate: true }] });
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'mixed' })).data.run;
  let v = (await run('workflow.approve', { run_id: launched.id })).data;
  assert.deepEqual(v.steps.map(s => [s.key, s.state]), [['note', 'resolved'], ['check', 'proposed']]);
  const auto = await ctxOf(v.steps[0].task.id);
  assert.equal(auto.completed.evidence.result.action, 'artifact.create');
  assert.ok(auto.completed.evidence.result.ledger_id, 'the action\'s own ledger row');
  assert.ok((await run('artifact.list', { artifact_type: 'note' })).data.artifacts.some(a => a.title === 'from a workflow'));
  await assert.rejects(run('task.complete', { task_id: v.steps[1].task.id }), err => err.status === 409 && err.code === 'TASK_STATE', 'gated: not ready until approved');
  await run('task.approve', { task_id: v.steps[1].task.id });
  await run('task.complete', { task_id: v.steps[1].task.id });
  assert.equal((await ctxOf(launched.id)).state, 'completed');

  // An automated step that fails leaves the run where it is.
  await run('workflow.define', { project_id: p.id, alias: 'broken', title: 'Broken', steps: [
    { key: 'get', title: 'Get nothing', mode: 'automated', action: 'artifact.get', payload: { artifact_id: '00000000-0000-0000-0000-000000000000' } }] });
  const b = (await run('workflow.launch', { project_id: p.id, alias: 'broken' })).data.run;
  v = (await run('workflow.approve', { run_id: b.id })).data;
  assert.equal(v.steps[0].state, 'ready');
  assert.ok(v.steps[0].error);
  assert.equal((await ctxOf(b.id)).state, 'running');
  assert.ok((await runEvents(b.id)).includes('workflow.step_failed'));
  v = (await run('workflow.advance', { run_id: b.id })).data; // retried, still failing
  assert.equal(v.steps[0].state, 'ready');
});

test('cancel stops a run; a PR intent can only fill a PR step that is waiting', async () => {
  const p = await project('Cancel');
  await run('workflow.define', { project_id: p.id, alias: 'one', title: 'One', steps: [{ key: 'a', title: 'A', mode: 'human' }, { key: 'b', title: 'B', mode: 'human' }] });
  const launched = (await run('workflow.launch', { project_id: p.id, alias: 'one' })).data.run;
  const v = (await run('workflow.approve', { run_id: launched.id })).data;
  await run('workflow.cancel', { run_id: launched.id, note: 'not needed' });
  await run('task.complete', { task_id: v.steps[0].task.id });
  assert.deepEqual((await inspect(launched.id)).steps.map(s => s.state), ['ready', 'pending'], 'a cancelled run doesn\'t move on');
  await assert.rejects(run('workflow.cancel', { run_id: launched.id }), err => err.code === 'RUN_FINISHED');

  const pr = { repository: { alias: 'site', path: '/repos/site' }, base: 'main', body: 'x' };
  await assert.rejects(run('task.propose', { project_id: p.id, title: 'not pr', workflow_step: { run_id: launched.id, step: 'a' } }), err => err.code === 'BAD_STEP');
  const cr = (await run('workflow.launch', { project_id: p.id, alias: 'code-review' })).data.run;
  await run('workflow.approve', { run_id: cr.id });
  const before = (await run('artifact.search', { artifact_type: 'task', ark_id: p.id })).data.artifacts.length;
  await assert.rejects(run('task.propose', { project_id: p.id, title: 'Too early', kind: 'pr', workflow_step: { run_id: cr.id, step: 'pr' }, pr }), err => err.code === 'STEP_NOT_WAITING');
  await assert.rejects(run('task.propose', { project_id: p.id, title: 'Wrong step', kind: 'pr', workflow_step: { run_id: cr.id, step: 'review' }, pr }), err => err.code === 'BAD_STEP');
  assert.equal((await run('artifact.search', { artifact_type: 'task', ark_id: p.id })).data.artifacts.length, before, 'refused intents leave nothing behind');
  await assert.rejects(run('workflow.launch', { project_id: p.id, alias: 'nope' }), err => err.code === 'WORKFLOW_NOT_FOUND');
});
