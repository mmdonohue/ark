'use strict';

// Project repositories and task inheritance through dispatch() on a
// throwaway sqlite vessel. The rule under test: approval pins the effective
// scope, so a project's repositories can't change what an approved task reads.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');
const { effectiveContext } = require('../actions/RepositoryActions');

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-repos-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const USER  = { ark_actor_id: 'actor-user',  store_id: 1, role: 'USER',  rank: 10,  source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'repos.sqlite') } });
});

const project = async title => (await run('ark.create', { title })).data.ark;
const addRepo = async (project_id, alias, p = `/repos/${alias}`, extra = {}) =>
  (await run('repository.add', { project_id, alias, path: p, ...extra })).data.repository;
const listRepos = async project_id => (await run('artifact.search', { artifact_type: 'repository', ark_id: project_id })).data.artifacts;
const ctxOf = async id => (await Artifact.findById(id, ADMIN)).get('context');
const effective = async id => effectiveContext(ADMIN, await Artifact.findById(id, ADMIN));
const inheriting = async (project_id, want = 'all', extra = {}) => (await run('task.propose', {
  project_id, title: `inherits ${JSON.stringify(want)}`, inputs: { project_repositories: want, ...extra }, required_capabilities: ['repo.read'],
})).data.task;

test('repository.add: a project-level artifact, validated, alias unique per project, admin only', async () => {
  const p = await project('Repos');
  const r = await addRepo(p.id, 'site', '/repos/site/', { default_branch: 'develop', remote: 'github.com/owner/site' });
  assert.equal(r.artifact_type, 'repository');
  assert.deepEqual({ alias: r.context.alias, path: r.context.path, default_branch: r.context.default_branch, remote: r.context.remote },
    { alias: 'site', path: '/repos/site', default_branch: 'develop', remote: 'github.com/owner/site' }, 'path normalized');
  assert.deepEqual((await listRepos(p.id)).map(a => a.id), [r.id], 'in the project');
  assert.equal((await addRepo(p.id, 'ark')).context.default_branch, 'main', 'default branch defaults to main');

  const bad = async (payload, code, ctx) => assert.rejects(run('repository.add', { project_id: p.id, ...payload }, ctx), err => err.code === code, JSON.stringify(payload));
  await bad({ alias: 'site', path: '/elsewhere' }, 'DUPLICATE_ALIAS');
  await bad({ alias: 'rel', path: 'repos/rel' }, 'BAD_REPOSITORY');
  await bad({ alias: '-dash', path: '/x' }, 'BAD_REPOSITORY');
  await bad({ alias: 'b', path: '/x', default_branch: '../main' }, 'BAD_REPOSITORY');
  await bad({ alias: 'r', path: '/x', remote: 'has space' }, 'BAD_REPOSITORY');
  await bad({ alias: 'u', path: '/x' }, 'CAPABILITY_DENIED', USER);
  await assert.rejects(run('repository.add', { project_id: '00000000-0000-0000-0000-000000000000', alias: 'x', path: '/x' }), err => err.code === 'PROJECT_NOT_FOUND');

  const other = await project('Other');
  assert.equal((await addRepo(other.id, 'site')).context.alias, 'site', 'aliases are per project');
});

test('repository.update / remove: alias fixed, changes recorded, removal takes it out of the project', async () => {
  const p = await project('Edit repos');
  const r = await addRepo(p.id, 'site');
  const u = await run('repository.update', { repository_id: r.id, path: '/moved/site', remote: 'github.com/o/site' });
  assert.deepEqual(u.data.changed, ['path', 'remote']);
  assert.equal(u.data.repository.context.path, '/moved/site');
  await assert.rejects(run('repository.update', { repository_id: r.id, alias: 'renamed' }), err => err.code === 'BAD_REPOSITORY');
  await assert.rejects(run('repository.update', { repository_id: r.id, path: '/moved/site' }), err => err.code === 'NO_CHANGE');
  const ev = (await run('artifact.get', { artifact_id: r.id })).data.events.find(e => e.event_type === 'repository.updated');
  assert.deepEqual(ev.payload.before, { path: '/repos/site', remote: null });

  await run('repository.remove', { repository_id: r.id });
  assert.deepEqual(await listRepos(p.id), []);
});

test('inheritance: "all" follows the project; a list picks aliases; own repositories add to them', async () => {
  const p = await project('Inherit');
  await addRepo(p.id, 'site');
  await addRepo(p.id, 'ark');
  const all = await inheriting(p.id, 'all', { repositories: [{ alias: 'scratch', path: '/tmp/scratch' }] });
  assert.deepEqual((await effective(all.id)).inputs.repositories, [
    { alias: 'ark', path: '/repos/ark', from: 'project' }, { alias: 'site', path: '/repos/site', from: 'project' },
    { alias: 'scratch', path: '/tmp/scratch' },
  ]);
  const some = await inheriting(p.id, ['site']);
  assert.deepEqual((await effective(some.id)).inputs.repositories.map(r => r.alias), ['site']);

  const plain = (await run('task.propose', { title: 'no inheritance', inputs: { repositories: [{ alias: 'x', path: '/x' }] } })).data.task;
  assert.deepEqual((await effective(plain.id)).inputs.repositories, [{ alias: 'x', path: '/x' }], 'tasks that don\'t opt in are unchanged');

  for (const inputs of [{ project_repositories: 'some' }, { project_repositories: [] }, { project_repositories: ['a', 'a'] }, { project_repositories: ['bad alias'] }]) {
    await assert.rejects(run('task.propose', { project_id: p.id, title: 'bad', inputs }), err => err.code === 'BAD_INPUTS', JSON.stringify(inputs));
  }
  await assert.rejects(run('task.propose', { title: 'orphan', inputs: { project_repositories: 'all' } }), err => err.code === 'BAD_INPUTS', 'needs a project');

  const clash = await inheriting(p.id, 'all', { repositories: [{ alias: 'site', path: '/other' }] });
  await assert.rejects(effective(clash.id), err => err.code === 'DUPLICATE_ALIAS');
  const missing = await inheriting(p.id, ['nope']);
  await assert.rejects(run('task.approve', { task_id: missing.id }), err => err.code === 'REPOSITORY_NOT_FOUND', 'unresolvable scope cannot be approved');
});

test('approval pins the inherited scope: a project change blocks the run until revise → approve', async () => {
  const p = await project('Pinned');
  const site = await addRepo(p.id, 'site');
  const t = await inheriting(p.id);
  await run('task.approve', { task_id: t.id });
  const pinned = (await ctxOf(t.id)).approved.scope_hash;
  const { scopeHash } = require('../utils/taskScope');
  assert.equal(pinned, scopeHash(await effective(t.id)), 'hash is over the effective scope');

  // Each of these changes what the task would read.
  for (const change of [
    () => addRepo(p.id, 'ark'),
    () => run('repository.update', { repository_id: site.id, path: '/repos/site-moved' }),
    () => run('repository.remove', { repository_id: site.id }),
  ]) {
    await change();
    await assert.rejects(run('harness.run', { task_id: t.id }), err => err.status === 409 && err.code === 'TASK_SCOPE_CHANGED');
    // Nothing in the task itself changed: revise with no changes sends it back.
    const r = await run('task.revise', { task_id: t.id, changes: {}, note: 'project repos changed' });
    assert.deepEqual(r.data.changed, ['inherited']);
    assert.equal(r.data.task.context.state, 'proposed');
    await run('task.approve', { task_id: t.id });
  }
  await assert.rejects(run('task.revise', { task_id: t.id, changes: {} }), err => err.code === 'NO_CHANGE', 'in sync → nothing to revise');

  // A change that doesn't touch what it reads (default branch) leaves the approval standing.
  const ark = (await listRepos(p.id)).find(a => json(a.context).alias === 'ark');
  await run('repository.update', { repository_id: ark.id, default_branch: 'develop' });
  assert.equal((await ctxOf(t.id)).approved.scope_hash, scopeHash(await effective(t.id)));
});

test('task.scope: effective repositories, and stale once the project moves under an approval', async () => {
  const p = await project('Scope read');
  const site = await addRepo(p.id, 'site');
  const t = await inheriting(p.id);
  let s = (await run('task.scope', { task_id: t.id })).data;
  assert.deepEqual(s, { repositories: [{ alias: 'site', path: '/repos/site', from: 'project' }], inherits: 'all', stale: false, error: null }, 'proposed: never stale');
  await run('task.approve', { task_id: t.id });
  assert.equal((await run('task.scope', { task_id: t.id })).data.stale, false);
  await run('repository.update', { repository_id: site.id, path: '/repos/elsewhere' });
  s = (await run('task.scope', { task_id: t.id })).data;
  assert.equal(s.stale, true);
  assert.equal(s.repositories[0].path, '/repos/elsewhere', 'shows what it would read now');
  await run('repository.remove', { repository_id: site.id });
  const broken = await inheriting(p.id, ['site']);
  assert.equal((await run('task.scope', { task_id: broken.id })).data.error.code, 'REPOSITORY_NOT_FOUND');
});

test('a task picking aliases is unaffected by repositories it did not pick', async () => {
  const p = await project('Picky');
  await addRepo(p.id, 'site');
  const t = await inheriting(p.id, ['site']);
  await run('task.approve', { task_id: t.id });
  const { scopeHash } = require('../utils/taskScope');
  await addRepo(p.id, 'ark');
  assert.equal((await ctxOf(t.id)).approved.scope_hash, scopeHash(await effective(t.id)), 'a new, unpicked repository changes nothing');
});

const json = v => (typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}));
