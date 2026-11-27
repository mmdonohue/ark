'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { once } = require('events');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const Artifact = require('../domain/Artifact');
const worktree = require('../utils/worktree');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-workspaces-test-'));
const REPOS = path.join(TMP, 'repos');
const ROOT = path.join(TMP, 'workspaces');
const REPO = path.join(REPOS, 'repo');
const DB = path.join(TMP, 'test.sqlite');
const OWNER = { ark_actor_id: 'owner', store_id: 1, rank: 100, role: 'ADMIN', source: 'cli' };
const USER = { ...OWNER, rank: 10, role: 'USER' };
const OTHER = { ...OWNER, store_id: 2 };
const run = (action, payload = {}, ctx = OWNER) => dispatch({ action, payload }, ctx);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
let project, repo, sha;

before(async () => {
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(ROOT);
  git(REPO, 'init', '-q');
  fs.writeFileSync(path.join(REPO, 'file.txt'), 'original\n');
  git(REPO, 'add', 'file.txt');
  git(REPO, 'commit', '-qm', 'initial');
  sha = git(REPO, 'rev-parse', 'HEAD');
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: DB },
    workspace: { root: ROOT, repository_roots: [REPOS] } });
  project = (await run('ark.create', { title: 'Workspace project' })).data.ark;
  repo = (await run('repository.add', { project_id: project.id, alias: 'site', path: REPO })).data.repository;
});

after(() => {
  _reset();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function task(title, extra = {}) {
  return (await run('task.propose', { project_id: project.id, title, description: 'Implement the approved change',
    inputs: { project_repositories: ['site'], workspace: { mode: 'implementation_worktree', repository_id: repo.id, alias: 'site', path: REPO, base_sha: sha } },
    required_capabilities: ['workspace.provision'], ...extra })).data.task;
}
async function provision(t, attempt = 1) {
  return (await run('workspace.provision', { task_id: t.id, attempt })).data;
}

test('requires a scoped, explicit owner approval and protects workspace records', async () => {
  const t = await task('approval');
  await assert.rejects(provision(t), e => e.code === 'TASK_NOT_APPROVED');
  await assert.rejects(run('task.approve', { task_id: t.id }, { ...OWNER, delegation: { via: 'harness' } }), e => e.code === 'OWNER_ONLY');
  await run('task.approve', { task_id: t.id });
  await assert.rejects(run('workspace.provision', { task_id: t.id, attempt: 1 }, USER), e => e.code === 'CAPABILITY_DENIED');
  await assert.rejects(run('workspace.provision', { task_id: t.id, attempt: 1 }, OTHER), e => e.code === 'TASK_NOT_FOUND');
  const w = (await provision(t)).workspace;
  await assert.rejects(run('artifact.update', { artifact_id: w.id, context: { path: '/tmp/elsewhere' } }), e => e.code === 'WORKSPACE_PROTECTED');
  await assert.rejects(run('artifact.create', { artifact_type: 'workspace', title: 'forged' }), e => e.code === 'WORKSPACE_PROTECTED');
  assert.equal((await run('workspace.list', { task_id: t.id })).data.workspaces.length, 1);
  assert.equal((await run('workspace.status', { workspace_id: w.id })).data.observed.head, sha);
  await assert.rejects(run('workspace.status', { workspace_id: w.id }, OTHER), e => e.code === 'WORKSPACE_NOT_FOUND');
});

test('pins task intent and refuses changed or unapproved repository scope', async () => {
  const t = await task('original');
  await run('task.approve', { task_id: t.id });
  await run('artifact.update', { artifact_id: t.id, title: 'changed after approval' });
  await assert.rejects(provision(t), e => e.code === 'TASK_SCOPE_CHANGED');
  const bad = await task('wrong repo', { inputs: { project_repositories: ['site'], workspace: {
    mode: 'implementation_worktree', repository_id: repo.id, alias: 'site', path: '/tmp/unapproved', base_sha: sha,
  } } });
  await assert.rejects(run('task.approve', { task_id: bad.id }), e => e.code === 'BAD_WORKSPACE_SCOPE');
  const noCapability = await task('missing capability', { required_capabilities: ['repo.read'] });
  await assert.rejects(run('task.approve', { task_id: noCapability.id }), e => e.code === 'BAD_WORKSPACE_SCOPE');
  const intent = (await run('artifact.create', { artifact_type: 'task', title: 'PR intent', ark_id: project.id,
    context: { ...noCapability.context, kind: 'pr', required_capabilities: ['workspace.provision'] } })).data.artifact;
  await assert.rejects(run('task.approve', { task_id: intent.id }), e => e.code === 'BAD_WORKSPACE_SCOPE');
});

test('rejects symlink escapes and Git filters, and never invokes checkout hooks', async () => {
  const outside = path.join(TMP, 'outside');
  const linkPath = path.join(REPOS, 'escape');
  fs.mkdirSync(outside);
  git(outside, 'init', '-q');
  fs.symlinkSync(outside, linkPath);
  const escaped = (await run('repository.add', { project_id: project.id, alias: 'escape', path: linkPath })).data.repository;
  const t = await task('escape', { inputs: { project_repositories: ['escape'], workspace: {
    mode: 'implementation_worktree', repository_id: escaped.id, alias: 'escape', path: linkPath, base_sha: sha,
  } } });
  await assert.rejects(run('task.approve', { task_id: t.id }), e => e.code === 'WORKSPACE_PATH_DENIED');

  const filtered = await task('filter');
  git(REPO, 'config', 'filter.unsafe.smudge', 'unsafe-command');
  try {
    await assert.rejects(run('task.approve', { task_id: filtered.id }), e => e.code === 'UNSAFE_GIT_CONFIG');
  } finally {
    git(REPO, 'config', '--unset', 'filter.unsafe.smudge');
  }
  const hook = path.join(REPO, '.git', 'hooks', 'post-checkout');
  const marker = path.join(TMP, 'hook-ran');
  fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  try {
    await run('task.approve', { task_id: filtered.id });
    await provision(filtered);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.unlinkSync(hook);
  }
});

test('separate attempts leave the primary checkout untouched and retry idempotently', async () => {
  const first = await task('first');
  const second = await task('second');
  await run('task.approve', { task_id: first.id });
  await run('task.approve', { task_id: second.id });
  const a = await provision(first);
  const b = await provision(second);
  assert.notEqual(a.workspace.context.path, b.workspace.context.path);
  assert.notEqual(a.workspace.context.branch, b.workspace.context.branch);
  assert.equal((await provision(first)).cached, true);
  assert.equal(git(REPO, 'rev-parse', 'HEAD'), sha);
  assert.equal(git(REPO, 'status', '--porcelain'), '');
});

test('cleanup requires confirmation and preserves ignored, dirty, committed and remote-linked work', async () => {
  const t = await task('preservation');
  await run('task.approve', { task_id: t.id });
  const w = (await provision(t)).workspace;
  const dir = w.context.path;
  const cleanup = () => run('workspace.cleanup', { workspace_id: w.id, confirm_no_pr_or_active_processes: true });
  await assert.rejects(run('workspace.cleanup', { workspace_id: w.id }), e => e.code === 'CLEANUP_CONFIRMATION_REQUIRED');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'keep');
  await assert.rejects(cleanup(), e => e.code === 'WORKSPACE_PRESERVED');
  fs.unlinkSync(path.join(dir, 'untracked.txt'));
  fs.appendFileSync(path.join(REPO, '.git', 'info', 'exclude'), '\nignored.tmp\n');
  fs.writeFileSync(path.join(dir, 'ignored.tmp'), 'keep too');
  await assert.rejects(cleanup(), e => e.code === 'WORKSPACE_PRESERVED');
  fs.unlinkSync(path.join(dir, 'ignored.tmp'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'changed\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '-qm', 'work');
  await assert.rejects(cleanup(), e => e.code === 'WORKSPACE_PRESERVED');
  assert.ok(fs.existsSync(dir));

  const cleanTask = await task('clean');
  await run('task.approve', { task_id: cleanTask.id });
  const clean = (await provision(cleanTask)).workspace;
  git(REPO, 'update-ref', `refs/remotes/origin/${clean.context.branch}`, sha);
  await assert.rejects(run('workspace.cleanup', { workspace_id: clean.id, confirm_no_pr_or_active_processes: true }), e => e.code === 'WORKSPACE_PRESERVED');
  git(REPO, 'update-ref', '-d', `refs/remotes/origin/${clean.context.branch}`);
  const done = (await run('workspace.cleanup', { workspace_id: clean.id, confirm_no_pr_or_active_processes: true })).data.workspace;
  assert.equal(done.context.state, 'cleaned');
  assert.equal(fs.existsSync(clean.context.path), false);
  assert.equal(git(REPO, 'rev-parse', `refs/heads/${clean.context.branch}`), sha, 'branch is not deleted');
  const { error } = await Artifact.db.from('artifacts').update({ context: { ...done.context, state: 'failed' } }).eq('id', clean.id);
  assert.equal(error, null);
  await assert.rejects(provision(cleanTask), e => e.code === 'WORKSPACE_COLLISION');
  assert.equal(git(REPO, 'rev-parse', `refs/heads/${clean.context.branch}`), sha, 'existing branch is never overwritten');
});

test('workspace state persists across a vessel restart', async () => {
  const t = await task('restart');
  await run('task.approve', { task_id: t.id });
  const w = (await provision(t)).workspace;
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: DB }, workspace: { root: ROOT, repository_roots: [REPOS] } });
  const result = (await run('workspace.status', { workspace_id: w.id })).data;
  assert.equal(result.workspace.context.state, 'ready');
  assert.equal(result.observed.head, sha);
});

test('recovery reconstructs an interrupted workspace and preserves changed work', async () => {
  const t = await task('recovery');
  await run('task.approve', { task_id: t.id });
  const w = (await provision(t)).workspace;
  const { error } = await Artifact.db.from('artifacts').update({ context: { ...w.context, state: 'provisioning' } }).eq('id', w.id);
  assert.equal(error, null);
  let r = (await run('workspace.recover', { workspace_id: w.id })).data;
  assert.equal(r.workspace.context.state, 'ready');
  fs.writeFileSync(path.join(w.context.path, 'file.txt'), 'unfinished\n');
  r = (await run('workspace.recover', { workspace_id: w.id })).data;
  assert.equal(r.workspace.context.state, 'preserved');
  const { error: updateError } = await Artifact.db.from('artifacts')
    .update({ context: { ...r.workspace.context, state: 'provisioning', creation_confirmed: false } }).eq('id', w.id);
  assert.equal(updateError, null);
  r = (await run('workspace.recover', { workspace_id: w.id })).data;
  assert.equal(r.workspace.context.state, 'preserved', 'an unconfirmed worktree is never adopted');
  await assert.rejects(run('workspace.cleanup', { workspace_id: w.id, confirm_no_pr_or_active_processes: true }), e => e.code === 'WORKSPACE_STATE');
});

test('duplicate provisioning across processes creates only one workspace', { timeout: 20000 }, async () => {
  const t = await task('concurrent attempt');
  await run('task.approve', { task_id: t.id });
  const script = `
    const { bootstrap } = require(${JSON.stringify(require.resolve('../core/bootstrap'))});
    const { dispatch } = require(${JSON.stringify(require.resolve('../core/dispatch'))});
    (async () => {
      await bootstrap({ db: { driver: 'sqlite', path: process.argv[1] },
        workspace: { root: process.argv[2], repository_roots: [process.argv[3]] } });
      console.log('READY');
      process.stdin.once('data', async () => {
        try {
          const r = await dispatch({ action: 'workspace.provision', payload: { task_id: process.argv[4], attempt: 1 } }, ${JSON.stringify(OWNER)});
          console.log('RESULT ' + JSON.stringify({ id: r.data.workspace.id, cached: r.data.cached }));
        } catch (e) {
          console.log('RESULT ' + JSON.stringify({ error: e.code || e.message }));
        }
      });
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ['-e', script, DB, ROOT, REPOS, t.id], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const ready = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stdout.on('data', data => {
        output += data;
        if (output.includes('READY\n')) resolve();
      });
      child.stderr.on('data', data => { errors += data; });
      child.on('exit', code => { if (!output.includes('READY\n')) reject(new Error(`Child exited ${code}: ${errors}`)); });
    });
    const exit = new Promise(resolve => child.on('exit', resolve));
    return { child, ready, exit, result: () => JSON.parse(output.split('\n').find(line => line.startsWith('RESULT ')).slice(7)) };
  });
  await Promise.all(children.map(c => c.ready));
  children.forEach(c => c.child.stdin.end('go'));
  await Promise.all(children.map(c => c.exit));
  const results = children.map(c => c.result());
  const success = results.filter(r => r.id);
  assert.ok(success.length >= 1);
  assert.equal(new Set(success.map(r => r.id)).size, 1);
  assert.ok(results.every(r => r.id || r.error === 'WORKSPACE_LOCKED'), JSON.stringify(results));
  assert.equal((await run('workspace.list', { task_id: t.id })).data.workspaces.length, 1);
  assert.equal((await provision(t)).workspace.id, success[0].id);
});

test('Lamb Mode holds provisioning and workspace records cannot be synced', async () => {
  const t = await task('quiet');
  await run('task.approve', { task_id: t.id });
  await run('vessel.quiet');
  try {
    await assert.rejects(provision(t), e => e.code === 'LAMB_MODE');
  } finally {
    await run('vessel.resume');
  }
  const w = (await provision(t)).workspace;
  const { _assertNoWorkspace } = require('../actions/SyncActions')._internals;
  const remote = rows => ({ from: () => ({ select: () => ({ in: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }) });
  await assert.rejects(_assertNoWorkspace([w], remote([])), e => e.code === 'WORKSPACE_PROTECTED');
  await assert.rejects(_assertNoWorkspace([{ id: w.id, artifact_type: 'note' }], remote([{ id: w.id }])), e => e.code === 'WORKSPACE_PROTECTED');
});

test('repository lock works across processes and stale lock recovery is explicit', async () => {
  const { common } = worktree.resolveRepository(REPO);
  const modulePath = require.resolve('../utils/worktree');
  const child = spawn(process.execPath, ['-e', `const w=require(${JSON.stringify(modulePath)}); w.withRepoLock(process.argv[1], async () => { console.log('locked'); await new Promise(r => process.stdin.once('data', r)); }).catch(e => { console.error(e); process.exitCode=1; });`, common], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [chunk] = await once(child.stdout, 'data');
    assert.match(String(chunk), /locked/);
    await assert.rejects(worktree.withRepoLock(common, async () => {}), e => e.code === 'WORKSPACE_LOCKED');
    await assert.rejects(worktree.withRepoLock(common, async () => {}, { recover: true }), e => e.code === 'WORKSPACE_LOCKED');
  } finally {
    child.stdin.end('release');
    await once(child, 'exit');
  }
  const lock = path.join(common, 'ark-workspace.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: 2147483647 }));
  await assert.rejects(worktree.withRepoLock(common, async () => {}), e => e.code === 'WORKSPACE_LOCKED');
  await worktree.withRepoLock(common, async () => {}, { recover: true });
  assert.equal(fs.existsSync(lock), false);
});
