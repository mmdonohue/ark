'use strict';

// snapshot — a pinned, read-only copy of a git tree for a harness to read.
//
// `git archive <sha>` rather than `git worktree add`: a worktree writes into
// the source repo's .git, and the harness contract is that neither repo is
// ever written. archive also gives secrets exclusion by construction — only
// tracked files come out, so .env, untracked work and node_modules never
// reach a prompt. A denylist pass catches secrets that were committed anyway.
//
// The copy is chmod'ed read-only and fingerprinted; verify() after the run
// proves (or disproves) that the harness didn't write to it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DENY = [/(^|\/)\.env(\.|$)/, /\.pem$/, /\.key$/, /\.p12$/, /credentials[^/]*\.json$/i, /(^|\/)secrets(\/|$)/, /(^|\/)id_(rsa|ed25519)/];

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// create({ repo, revision='HEAD', subpath?, dest })
// → { path, revision, requested, dirty: string[], nonreproducible, excluded: string[], fingerprint, files }
function create({ repo, revision = 'HEAD', subpath = null, dest }) {
  const sha = git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();

  // Dirty state only matters when the caller asked for the working tree's
  // commit — a pinned SHA is reproducible no matter what's uncommitted.
  const pinnedToHead = revision === 'HEAD' || sha === git(repo, ['rev-parse', 'HEAD']).trim();
  const statusArgs = ['status', '--porcelain', '--untracked-files=no', ...(subpath ? ['--', subpath] : [])];
  const dirty = pinnedToHead
    ? git(repo, statusArgs).split('\n').filter(Boolean).map(l => l.slice(3))
    : [];

  fs.mkdirSync(dest, { recursive: true });
  const tar = git(repo, ['archive', '--format=tar', sha, ...(subpath ? [subpath] : [])], { encoding: 'buffer' });
  execFileSync('tar', ['-x', '-C', dest], { input: tar });

  // A file subpath scopes to its directory (which then holds only that file).
  let root = subpath ? path.join(dest, subpath) : dest;
  if (fs.statSync(root).isFile()) root = path.dirname(root);
  const excluded = [];
  for (const rel of listFiles(root)) {
    // Symlinks go too: a tracked link to ~/.ssh would hand the harness a
    // path outside the snapshot.
    if (DENY.some(re => re.test(rel)) || fs.lstatSync(path.join(root, rel)).isSymbolicLink()) {
      fs.rmSync(path.join(root, rel), { force: true });
      excluded.push(rel);
    }
  }

  const { fingerprint, files } = fingerprintDir(root);
  execFileSync('chmod', ['-R', 'a-w', dest]);

  return { path: root, subpath, revision: sha, requested: revision, dirty, nonreproducible: dirty.length > 0, excluded, fingerprint, files };
}

function verify(snap) {
  return fingerprintDir(snap.path).fingerprint === snap.fingerprint;
}

function remove(dir) {
  if (!fs.existsSync(dir)) return;
  execFileSync('chmod', ['-R', 'u+w', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
}

function listFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out.sort();
}

function fingerprintDir(root) {
  const h = crypto.createHash('sha256');
  const files = listFiles(root);
  for (const rel of files) {
    h.update(rel).update('\0');
    h.update(fs.readFileSync(path.join(root, rel))).update('\0');
  }
  return { fingerprint: h.digest('hex'), files: files.length };
}

module.exports = { create, verify, remove, fingerprint: fingerprintDir, _internals: { DENY, listFiles } };
