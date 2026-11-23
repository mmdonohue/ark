'use strict';

// Workflow definitions: validation, template defaults, project overrides by
// alias, revisions, and who may change them.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const { seedProjectTemplates, DOMAIN_TEMPLATES } = require('../cli/seedProjects');
const { definitionError, normalize } = require('../utils/workflowDef');
const { _internals: TR } = require('../core/TemplateResolver');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-workflows-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);
const defs = async project_id => (await run('workflow.definitions', { project_id })).data.workflows;

const step = (o = {}) => ({ key: 'review', title: 'Review', mode: 'ai', ...o });
const def = (o = {}) => ({ alias: 'nightly', title: 'Nightly', steps: [step()], ...o });

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'workflows.sqlite') } });
  await seedProjectTemplates(dispatch, ADMIN);
});
after(() => { _reset(); fs.rmSync(TMP, { recursive: true, force: true }); });

const developerProject = async title => (await run('ark.create', { title, template_id: 'project-developer' })).data.ark;

test('definitionError: the shape a step may take', () => {
  assert.equal(definitionError(def()), null);
  const bad = (d, re) => assert.match(String(definitionError(d)), re, JSON.stringify(d));
  bad(def({ alias: '-x' }), /alias/);
  bad(def({ steps: [] }), /1–20/);
  bad(def({ steps: [step({ mode: 'robot' })] }), /mode/);
  bad(def({ steps: [step(), step()] }), /used twice/);
  bad(def({ steps: [step({ key: 'Review' })] }), /key/);
  bad(def({ steps: [step({ required_capabilities: ['repo.write'] })] }), /read-only review/);
  bad(def({ steps: [step({ execution_policy: { drivers: [] } })] }), /execution_policy/);
  bad(def({ steps: [step({ action: 'artifact.list' })] }), /only apply to automated/);
  bad(def({ steps: [step({ mode: 'human', kind: 'deploy' })] }), /kind can only be "pr"/);
  bad(def({ steps: [step({ mode: 'ai', kind: 'pr' })] }), /only apply to human/);
  bad(def({ steps: [step({ mode: 'automated' })] }), /action is required/);
  bad(def({ steps: [step({ mode: 'automated', action: 'task.approve' })] }), /can't be automated/);
  bad(def({ steps: [step({ mode: 'automated', action: 'harness.run' })] }), /can't be automated/);
  for (const action of ['system.cycle', 'event.create', 'template.get', 'catalog.generate_sale_code', 'ledger.list', 'sync.push', 'ark_actor.create', 'repository.add']) {
    bad(def({ steps: [step({ mode: 'automated', action })] }), /can't be automated — only artifact, ark, media/);
  }
  assert.equal(definitionError(def({ steps: [step({ mode: 'automated', action: 'media.classify_batch' })] })), null, 'content/pipeline domains are allowed');
  assert.match(definitionError(def({ steps: [step({ mode: 'automated', action: 'artifact.nothing' })] }), { registered: new Set(['artifact.list']) }), /not a registered action/);
  bad(def({ steps: [step({ extra: 1 })] }), /unknown field "extra"/);
  bad(def({ inputs: { repositories: [] } }), /inputs may only set/);
  bad(def({ inputs: { project_repositories: ['a', 'a'] } }), /project_repositories/);
});

test('normalize: defaults applied; a PR intent is always gated', () => {
  const n = normalize(def({ steps: [step(), step({ key: 'pr', mode: 'human', kind: 'pr', gate: false })] }));
  assert.deepEqual(n.inputs, { project_repositories: 'all' });
  assert.deepEqual(n.steps[0].required_capabilities, ['repo.read']);
  assert.equal(n.steps[0].gate, false);
  assert.equal(n.steps[1].gate, true, 'gate: false is overridden for kind "pr"');
});

test('template contract: workflows merge by alias, the composing template wins', () => {
  const base = { ...TR._emptyContract(), workflows: [{ alias: 'a', title: 'base a' }, { alias: 'b', title: 'base b' }] };
  const over = { ...TR._emptyContract(), workflows: [{ alias: 'b', title: 'domain b' }, { alias: 'c', title: 'domain c' }] };
  assert.deepEqual(TR._merge(base, over).workflows.map(w => `${w.alias}:${w.title}`), ['a:base a', 'b:domain b', 'c:domain c']);
  for (const w of DOMAIN_TEMPLATES.flatMap(t => t.metadata.workflows || [])) assert.equal(definitionError(w), null, `seeded ${w.alias} is valid`);
});

test('workflow.definitions: a developer project offers the template\'s code review', async () => {
  const p = await developerProject('Defaults');
  const [cr] = await defs(p.id);
  assert.deepEqual({ alias: cr.alias, from: cr.from, template: cr.template, revision: cr.revision },
    { alias: 'code-review', from: 'template', template: 'project-developer', revision: 1 });
  assert.deepEqual(cr.steps.map(s => [s.key, s.mode, s.gate]), [['review', 'ai', false], ['triage', 'human', false], ['pr', 'human', true]]);

  const plain = (await run('ark.create', { title: 'No template' })).data.ark;
  assert.deepEqual(await defs(plain.id), [], 'an Ark without a template offers none');
  await assert.rejects(run('workflow.definitions', { project_id: '00000000-0000-0000-0000-000000000000' }), err => err.code === 'PROJECT_NOT_FOUND');
});

test('workflow.define: a project overrides a default by alias, or adds its own; admin only', async () => {
  const p = await developerProject('Overrides');
  const mine = (await run('workflow.define', { project_id: p.id, alias: 'code-review', title: 'Quick review',
    steps: [{ key: 'review', title: 'Agent review', mode: 'ai' }] })).data.workflow;
  await run('workflow.define', { project_id: p.id, alias: 'cleanup', title: 'Cleanup',
    steps: [{ key: 'list', title: 'List stale artifacts', mode: 'automated', action: 'artifact.list', payload: { limit: 5 } }, { key: 'decide', title: 'Decide', mode: 'human' }] });

  const list = await defs(p.id);
  assert.deepEqual(list.map(w => [w.alias, w.from, w.revision]), [['cleanup', 'project', 1], ['code-review', 'project', 1]]);
  const cr = list.find(w => w.alias === 'code-review');
  assert.equal(cr.id, mine.id);
  assert.equal(cr.overrides, 'project-developer');
  assert.equal(cr.title, 'Quick review');
  assert.deepEqual(await defs((await developerProject('Untouched')).id).then(l => l.map(w => w.title)), ['Code review'], 'other projects keep the default');

  const bad = async (payload, code, ctx) => assert.rejects(run('workflow.define', { project_id: p.id, ...payload }, ctx), err => err.code === code, JSON.stringify(payload));
  await bad({ alias: 'cleanup', title: 'Again', steps: [step()] }, 'DUPLICATE_ALIAS');
  await bad({ alias: 'auto', title: 'Auto approve', steps: [step({ mode: 'automated', action: 'task.approve' })] }, 'BAD_WORKFLOW');
  await bad({ alias: 'ghost', title: 'Ghost', steps: [step({ mode: 'automated', action: 'artifact.nothing' })] }, 'BAD_WORKFLOW');
  await bad({ alias: 'mine', title: 'Mine', steps: [step()] }, 'CAPABILITY_DENIED', USER);
});

test('workflow.redefine: every change is a new revision; the event keeps the previous one; alias is fixed', async () => {
  const p = await developerProject('Revisions');
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'ship', title: 'Ship', steps: [step()] })).data.workflow;
  const r = await run('workflow.redefine', { workflow_id: wf.id, changes: { steps: [step(), step({ key: 'pr', title: 'PR', mode: 'human', kind: 'pr' })] }, note: 'add a PR step' });
  assert.deepEqual(r.data.changed, ['steps']);
  const now = (await defs(p.id)).find(w => w.alias === 'ship');
  assert.equal(now.revision, 2);
  assert.equal(now.steps[1].gate, true);

  const ev = (await run('artifact.get', { artifact_id: wf.id })).data.events.find(e => e.event_type === 'workflow.redefined');
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  assert.deepEqual({ from: payload.from_revision, to: payload.to_revision, note: payload.note, prevSteps: payload.previous.steps.length },
    { from: 1, to: 2, note: 'add a PR step', prevSteps: 1 });

  await assert.rejects(run('workflow.redefine', { workflow_id: wf.id, changes: { alias: 'renamed' } }), err => err.code === 'BAD_CHANGES' && /alias can't change/.test(err.message));
  await assert.rejects(run('workflow.redefine', { workflow_id: wf.id, changes: { title: 'Ship' } }), err => err.code === 'NO_CHANGE');
  await assert.rejects(run('workflow.redefine', { workflow_id: wf.id, changes: { steps: [] } }), err => err.code === 'BAD_WORKFLOW');
  await assert.rejects(run('workflow.redefine', { workflow_id: wf.id, changes: { title: 'x' } }, USER), err => err.code === 'CAPABILITY_DENIED');
});

test('workflow.retire: the project\'s definition goes; the template default applies again', async () => {
  const p = await developerProject('Retire');
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'code-review', title: 'Mine', steps: [step()] })).data.workflow;
  assert.equal((await defs(p.id))[0].from, 'project');
  await run('workflow.retire', { workflow_id: wf.id });
  const [cr] = await defs(p.id);
  assert.deepEqual({ from: cr.from, title: cr.title }, { from: 'template', title: 'Code review' });
  await assert.rejects(run('workflow.retire', { workflow_id: p.id }), err => err.code === 'WORKFLOW_NOT_FOUND', 'only a workflow can be retired');
});

test('a retired workflow can be neither redefined nor retired again', async () => {
  const p = await developerProject('Retired');
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'once', title: 'Once', steps: [step()] })).data.workflow;
  await run('workflow.retire', { workflow_id: wf.id });
  await assert.rejects(run('workflow.redefine', { workflow_id: wf.id, changes: { title: 'Again' } }), err => err.status === 409 && err.code === 'WORKFLOW_RETIRED');
  await assert.rejects(run('workflow.retire', { workflow_id: wf.id }), err => err.status === 409 && err.code === 'WORKFLOW_RETIRED');
  const events = (await run('artifact.get', { artifact_id: wf.id })).data.events.map(e => e.event_type);
  assert.deepEqual(events.filter(t => t.startsWith('workflow.')).sort(), ['workflow.defined', 'workflow.retired'], 'no event on the orphan');
});

test('concurrent defines of one alias: exactly one wins (repositories too)', async () => {
  const p = await developerProject('Race');
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    run('workflow.define', { project_id: p.id, alias: 'racy', title: `Racy ${i}`, steps: [step()] })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'DUPLICATE_ALIAS'));
  assert.equal((await defs(p.id)).filter(w => w.alias === 'racy').length, 1);

  const repos = await Promise.allSettled(Array.from({ length: 5 }, () =>
    run('repository.add', { project_id: p.id, alias: 'site', path: '/repos/site' })));
  assert.equal(repos.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(repos.filter(r => r.status === 'rejected').every(r => r.reason.code === 'DUPLICATE_ALIAS'));

  // Different projects don't wait on each other's lock.
  const q = await developerProject('Race 2');
  const both = await Promise.all([p, q].map(x => run('workflow.define', { project_id: x.id, alias: 'parallel', title: 'P', steps: [step()] })));
  assert.equal(both.length, 2);
});
