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
  bad(def({ steps: [step({ execution_policy: { sandbox: { runtime: 'apple-container', network: 'none',
    image: `example/agent@sha256:${'a'.repeat(64)}`, timeout_ms: 1000 } } })] }), /sandbox execution is not available/);
  bad(def({ steps: [step({ action: 'artifact.list' })] }), /only apply to automated/);
  bad(def({ steps: [step({ mode: 'human', kind: 'deploy' })] }), /kind can only be "pr"/);
  bad(def({ steps: [step({ mode: 'ai', kind: 'pr' })] }), /only apply to human/);
  bad(def({ steps: [step({ mode: 'automated' })] }), /action is required/);
  bad(def({ steps: [step({ mode: 'automated', action: 'task.approve' })] }), /can't be automated/);
  bad(def({ steps: [step({ mode: 'automated', action: 'harness.run' })] }), /can't be automated/);
  for (const action of ['system.cycle', 'event.create', 'template.get', 'catalog.generate_sale_code', 'ledger.list', 'sync.push', 'ark_actor.create', 'repository.add']) {
    bad(def({ steps: [step({ mode: 'automated', action })] }), /can't be automated — an automated step may only read or add/);
  }
  bad(def({ steps: [step({ extra: 1 })] }), /unknown field "extra"/);
  bad(def({ inputs: { repositories: [] } }), /inputs may only set/);
  bad(def({ inputs: { project_repositories: ['a', 'a'] } }), /project_repositories/);
  assert.equal(definitionError(def({ steps: [step({ mode: 'automated', action: 'media.classify_batch' })] })), null);
});

test('automated steps: an explicit list of actions that only read or add — destructive ones are refused on purpose', () => {
  const { AUTOMATED_ACTIONS } = require('../utils/workflowDef');
  const { ACTION_REGISTRY } = require('../core/dispatch');
  const auto = action => definitionError(def({ steps: [step({ mode: 'automated', action })] }));
  for (const action of ['artifact.create', 'artifact.relate', 'artifact.list', 'ark.add_artifact', 'ark.get']) assert.equal(auto(action), null, `${action} is allowed`);
  for (const action of [
    'artifact.archive', 'artifact.update', 'artifact.unrelate', 'artifact.remove_media', 'artifact.delete',
    'ark.archive', 'ark.update', 'ark.remove_artifact', 'ark.move_artifact', 'ark.reorder_artifacts', 'ark.create',
    'pipeline.run', 'pipeline.register', 'cache.promote_bucket', 'cinema.render_reel', 'chat.import', 'media.archive_copy',
  ]) assert.match(String(auto(action)), /may only read or add/, `${action} is refused`);
  for (const a of AUTOMATED_ACTIONS) assert.ok(ACTION_REGISTRY[a], `${a} is a real action`);
  // Listed but missing from this build's registry (e.g. a host without it).
  assert.match(definitionError(def({ steps: [step({ mode: 'automated', action: 'artifact.create' })] }), { registered: new Set(['artifact.list']) }), /not a registered action/);
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

test('concurrent redefines: each becomes its own revision; the event log keeps every one', async () => {
  const p = await developerProject('Edit race');
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'busy', title: 'Busy', steps: [step()] })).data.workflow;
  const titles = ['A', 'B', 'C', 'D', 'E'];
  await Promise.all(titles.map(t => run('workflow.redefine', { workflow_id: wf.id, changes: { title: `Busy ${t}` } })));

  const now = (await defs(p.id)).find(w => w.alias === 'busy');
  assert.equal(now.revision, 6, 'five edits on revision 1 → revision 6');
  const evs = (await run('artifact.get', { artifact_id: wf.id })).data.events
    .filter(e => e.event_type === 'workflow.redefined').map(e => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload))
    .sort((x, y) => x.to_revision - y.to_revision);
  assert.deepEqual(evs.map(e => [e.from_revision, e.to_revision]), [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]);
  // Each edit replaced the one before it: the previous titles chain.
  assert.equal(evs[0].previous.title, 'Busy');
  for (let i = 1; i < evs.length; i++) assert.notEqual(evs[i].previous.title, 'Busy', `edit ${i + 1} saw edit ${i}`);
  assert.equal(new Set(evs.map(e => e.previous.title)).size, 5, 'no edit was lost: five different predecessors');

  // A retire racing an edit: whichever goes second sees the other's result.
  const wf2 = (await run('workflow.define', { project_id: p.id, alias: 'gone', title: 'Gone', steps: [step()] })).data.workflow;
  const [edit, ret] = await Promise.allSettled([
    run('workflow.redefine', { workflow_id: wf2.id, changes: { title: 'Gone 2' } }),
    run('workflow.retire', { workflow_id: wf2.id }),
  ]);
  assert.equal(ret.status, 'fulfilled');
  assert.ok(edit.status === 'fulfilled' || edit.reason.code === 'WORKFLOW_RETIRED');
});

test('template defaults get the same registered-action check as project definitions', async () => {
  const TemplateResolver = require('../core/TemplateResolver');
  const { ACTION_REGISTRY } = require('../core/dispatch');
  const p = await developerProject('Bad default');
  const real = TemplateResolver.resolve;
  // An allowlisted action this build doesn't register: only the registered
  // check can catch it.
  const removed = ACTION_REGISTRY['artifact.relate'];
  delete ACTION_REGISTRY['artifact.relate'];
  TemplateResolver.resolve = async id => {
    const c = await real.call(TemplateResolver, id);
    return c && { ...c, workflows: [...c.workflows, { alias: 'ghost', title: 'Ghost', steps: [{ key: 'x', title: 'X', mode: 'automated', action: 'artifact.relate' }] }] };
  };
  try {
    const ghost = (await defs(p.id)).find(w => w.alias === 'ghost');
    assert.equal(ghost.from, 'template');
    assert.match(ghost.error, /"artifact.relate" is not a registered action/);
    assert.equal(ghost.steps, undefined, 'an invalid default is listed, not usable');
  } finally {
    TemplateResolver.resolve = real;
    ACTION_REGISTRY['artifact.relate'] = removed;
  }
});

test('alias uniqueness is enforced by the database too — another process can\'t slip a duplicate in', async () => {
  const Artifact = require('../domain/Artifact');
  const { aliasSlug, isUniqueViolation } = require('../utils/aliasSlug');
  const p = await developerProject('Unique');

  // Another process inserted "shared" after our lock-protected check would
  // have run: a row with the reserved slug the app check can't see yet.
  await new Artifact({ artifact_type: 'workflow', slug: aliasSlug('workflow', p.id, 'shared'), title: 'Other process', context: { alias: 'shared', visibility: 'private' } }, { context: ADMIN }).save();
  await assert.rejects(run('workflow.define', { project_id: p.id, alias: 'shared', title: 'Mine', steps: [step()] }), err => err.status === 409 && err.code === 'DUPLICATE_ALIAS');
  await new Artifact({ artifact_type: 'repository', slug: aliasSlug('repository', p.id, 'site'), title: 'site', context: { alias: 'site', path: '/x', visibility: 'private' } }, { context: ADMIN }).save();
  await assert.rejects(run('repository.add', { project_id: p.id, alias: 'site', path: '/repos/site' }), err => err.status === 409 && err.code === 'DUPLICATE_ALIAS');

  // Retiring frees the alias.
  const wf = (await run('workflow.define', { project_id: p.id, alias: 'again', title: 'First', steps: [step()] })).data.workflow;
  assert.equal(wf.slug, aliasSlug('workflow', p.id, 'again'));
  await run('workflow.retire', { workflow_id: wf.id });
  assert.ok((await run('workflow.define', { project_id: p.id, alias: 'again', title: 'Second', steps: [step()] })).data.workflow.id);

  assert.ok(isUniqueViolation({ message: 'UNIQUE constraint failed: artifacts.slug' }));
  assert.ok(isUniqueViolation({ code: '23505', message: 'duplicate key value violates unique constraint "ux_artifacts_project_alias"' }));
  assert.ok(!isUniqueViolation({ message: 'database is locked' }));
});

test('sqlite: rows from before the reserved slug are backfilled; existing duplicates don\'t stop a vessel opening', async () => {
  const SqliteAdapter = require('../adapters/sqlite');
  const file = path.join(TMP, 'legacy.sqlite');
  const seed = new SqliteAdapter(file);
  await seed.connect();
  const db = seed.db;
  db.exec('DROP INDEX ux_artifacts_project_alias');
  const row = (id, alias) => db.prepare(`INSERT INTO artifacts (id, store_id, artifact_type, title, context, inactive) VALUES (?, 1, 'repository', ?, ?, 0)`).run(id, alias, JSON.stringify({ alias }));
  const rel = id => db.prepare(`INSERT INTO artifact_relations (id, source_artifact_id, target_artifact_id, relation_type) VALUES (?, 'proj-1', ?, 'contains')`).run(`rel-${id}`, id);
  row('r1', 'site'); rel('r1');
  row('r2', 'ark');  rel('r2');
  db.close();

  const reopened = new SqliteAdapter(file);
  await reopened.connect();
  assert.deepEqual(reopened.db.prepare(`SELECT id, slug FROM artifacts ORDER BY id`).all(), [{ id: 'r1', slug: 'repository:proj-1:site' }, { id: 'r2', slug: 'repository:proj-1:ark' }]);
  assert.ok(reopened.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'ux_artifacts_project_alias'`).get());
  // A live duplicate (a race before this index existed): backfill can't
  // give both the slug, the index isn't built, and the vessel still opens.
  reopened.db.exec('DROP INDEX ux_artifacts_project_alias');
  reopened.db.prepare(`INSERT INTO artifacts (id, store_id, artifact_type, title, context, inactive) VALUES ('r3', 1, 'repository', 'site', ?, 0)`).run(JSON.stringify({ alias: 'site' }));
  reopened.db.prepare(`INSERT INTO artifact_relations (id, source_artifact_id, target_artifact_id, relation_type) VALUES ('rel-r3', 'proj-1', 'r3', 'contains')`).run();
  reopened.db.close();

  const warn = console.warn;
  const warnings = [];
  console.warn = m => warnings.push(m);
  try {
    const third = new SqliteAdapter(file);
    await third.connect();
    assert.ok(!third.db.prepare(`SELECT name FROM sqlite_master WHERE name = 'ux_artifacts_project_alias'`).get(), 'not built over duplicates');
    assert.equal(third.db.prepare(`SELECT count(*) AS n FROM artifacts`).get().n, 3, 'opened and readable');
    third.db.close();
  } finally {
    console.warn = warn;
  }
  assert.match(warnings.join('\n'), /alias uniqueness index not built/);
});
