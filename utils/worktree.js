'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getManifest } = require('../core/bootstrap');

const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const inside = (root, p) => p === root || p.startsWith(root + path.sep);

function config() {
  const c = getManifest().config.workspace || {};
  if (!path.isAbsolute(c.root || '') || !Array.isArray(c.repository_roots) || !c.repository_roots.length
      || c.repository_roots.some(r => !path.isAbsolute(r))) {
    throw fail('WORKSPACE_NOT_CONFIGURED', 'Configure workspace.root and workspace.repository_roots as existing absolute paths', 422);
  }
  let root, roots;
  try {
    root = fs.realpathSync(c.root);
    roots = c.repository_roots.map(r => fs.realpathSync(r));
  } catch (err) {
    throw fail('WORKSPACE_NOT_CONFIGURED', `Workspace configuration path unavailable: ${err.message}`, 422);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022)) {
    throw fail('UNSAFE_WORKSPACE_ROOT', 'The workspace root must be a directory owned by this user and not writable by group or others', 403);
  }
  return { root, roots };
}

function git(repo, args, { allowNoMatch = false } = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: os.homedir(),
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    if (allowNoMatch && err.status === 1) return '';
    throw fail('WORKSPACE_GIT_FAILED', `Git ${args[0]} failed: ${String(err.stderr || err.message).trim()}`, 422);
  }
}

function resolveRepository(repositoryPath) {
  const { root, roots } = config();
  let repo;
  try { repo = fs.realpathSync(repositoryPath); }
  catch (err) { throw fail('REPOSITORY_UNAVAILABLE', `Repository is unavailable: ${err.message}`, 422); }
  if (!roots.some(r => inside(r, repo)) || inside(repo, root) || inside(root, repo)) {
    throw fail('WORKSPACE_PATH_DENIED', 'Repository must be under an approved repository root and separate from the workspace root', 403);
  }
  const top = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (top !== repo) throw fail('WORKSPACE_PATH_DENIED', 'Repository path must name the Git checkout root', 403);
  const common = fs.realpathSync(path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim()));
  if (!roots.some(r => inside(r, common)) || inside(root, common) || inside(common, root)) {
    throw fail('WORKSPACE_PATH_DENIED', 'Git common directory must be under an approved repository root and separate from the workspace root', 403);
  }
  if (git(repo, ['config', '--get-regexp', '^filter\\.'], { allowNoMatch: true }).trim()) {
    throw fail('UNSAFE_GIT_CONFIG', 'Repository Git filters must be removed before provisioning', 403);
  }
  const identity = p => {
    const s = fs.statSync(p);
    return `${s.dev}:${s.ino}`;
  };
  return { repo, common, root, repo_identity: identity(repo), common_identity: identity(common), root_identity: identity(root) };
}

function verifyBase(repo, sha) {
  if (!/^[0-9a-f]{40,64}$/.test(sha || '')) throw fail('BAD_BASE_SHA', 'A full lowercase commit SHA is required', 422);
  const actual = git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  if (actual !== sha) throw fail('BAD_BASE_SHA', 'The base SHA must resolve to the exact commit', 422);
}

function entries(repo) {
  return git(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    return Object.fromEntries(fields.filter(Boolean).map(f => {
      const i = f.indexOf(' ');
      return i < 0 ? [f, true] : [f.slice(0, i), f.slice(i + 1)];
    }));
  });
}

function inspect(info) {
  const match = entries(info.repo).find(e => e.worktree === info.path);
  const exists = fs.existsSync(info.path);
  const branchSha = git(info.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`], { allowNoMatch: true }).trim();
  if (!match && !exists) return { exists: false, branch_sha: branchSha || null };
  if (!match || !exists || fs.realpathSync(info.path) !== info.path || match.branch !== `refs/heads/${info.branch}`) {
    throw fail('WORKSPACE_MISMATCH', 'Workspace path or Git registration does not match the recorded attempt');
  }
  const common = fs.realpathSync(path.resolve(info.path, git(info.path, ['rev-parse', '--git-common-dir']).trim()));
  if (common !== info.common) throw fail('WORKSPACE_MISMATCH', 'Workspace points to a different Git repository');
  const head = git(info.path, ['rev-parse', 'HEAD']).trim();
  const dirty = !!git(info.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  const remoteRefs = git(info.repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/']).split('\n')
    .filter(r => r.endsWith(`/${info.branch}`));
  return { exists: true, head, branch_sha: branchSha || null, dirty, remote_refs: remoteRefs };
}

async function withRepoLock(common, fn, { recover = false } = {}) {
  const lock = path.join(common, 'ark-workspace.lock');
  const ownerFile = path.join(lock, 'owner.json');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!recover) throw fail('WORKSPACE_LOCKED', 'Another workspace operation holds the repository lock');
    const recovery = `${lock}.recovery`;
    try {
      fs.mkdirSync(recovery, { mode: 0o700 });
    } catch (e) {
      if (e.code === 'EEXIST') throw fail('WORKSPACE_LOCKED', 'Repository lock recovery is already in progress');
      throw e;
    }
    try {
      let owner;
      try {
        if (!fs.lstatSync(lock).isDirectory() || !fs.lstatSync(ownerFile).isFile()) throw new Error('Invalid lock files');
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      }
      catch { throw fail('WORKSPACE_LOCK_UNKNOWN', 'Lock ownership is unknown; inspect it manually'); }
      if (owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) {
        throw fail('WORKSPACE_LOCK_UNKNOWN', 'Lock belongs to another host or has invalid ownership; inspect it manually');
      }
      try {
        process.kill(owner.pid, 0);
        throw fail('WORKSPACE_LOCKED', 'The repository lock owner is still running');
      } catch (probe) {
        if (probe.code !== 'ESRCH') throw probe;
      }
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lock);
      try { fs.mkdirSync(lock, { mode: 0o700 }); }
      catch (e) { if (e.code === 'EEXIST') throw fail('WORKSPACE_LOCKED', 'Another operation acquired the repository lock'); throw e; }
    } finally {
      fs.rmdirSync(recovery);
    }
  }
  try {
    fs.writeFileSync(ownerFile, JSON.stringify({ host: os.hostname(), pid: process.pid }), { flag: 'wx', mode: 0o600 });
    return await fn();
  } finally {
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock);
  }
}

module.exports = { config, git, resolveRepository, verifyBase, inspect, withRepoLock };
