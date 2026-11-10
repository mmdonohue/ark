'use strict';

// drift — deterministic evidence for a two-tree drift review.
//
// The agent gets read-only file tools and nothing else, so it can't run git.
// Everything that needs git is computed here, before the run, from the two
// pinned snapshots and their source repos, and written next to them as a
// read-only `drift/` directory:
//
//   drift/manifest.json        every file: only_in, identical or differs,
//                              with line counts and a direction hint
//   drift/diffs/<path>.diff    unified diff, base → head
//   drift/history/<alias>/<path>.log   last commits touching it on each side
//
// Direction comes from content addressing, not dates: if one side's current
// blob appears anywhere in the other side's history at its pinned revision,
// the other side has held that exact content and moved past it. Seen both
// ways means the sides swapped edits; neither way means they diverged (or
// one was edited in place without ever matching).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIFF_CAP = 200 * 1024;
const HISTORY_LIMIT = 8;

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function blobOf(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// The first commit (newest first) in `revision`'s history that contained this
// exact blob, or null.
function findBlob(repo, revision, blob) {
  const out = git(repo, ['log', revision, '--format=%H%x09%cI', '-n', '1', `--find-object=${blob}`]).trim();
  if (!out) return null;
  const [sha, date] = out.split('\t');
  return { sha, date };
}

function history(repo, revision, repoPath) {
  return git(repo, ['log', revision, `-n${HISTORY_LIMIT}`, '--format=%h %cI %s', '--', repoPath]).trim();
}

function lineCount(file) {
  const s = fs.readFileSync(file, 'utf8');
  return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
}

function listFiles(root, rel = '') {
  const out = [];
  if (!fs.existsSync(path.join(root, rel))) return out;
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out;
}

// side: { alias, repo, revision, subpath, path }  — a snapshot plus its source repo
// compare({ base, head, paths?, dest, root? }) → manifest
// root: the directory the agent works in (diff headers are relative to it).
function compare({ base, head, paths = [], dest, root = path.dirname(dest) }) {
  const inScope = rel => !paths.length || paths.some(p => rel === p || rel.startsWith(`${p.replace(/\/$/, '')}/`));
  const repoPath = (side, rel) => (side.subpath ? path.posix.join(side.subpath, rel) : rel);
  const all = [...new Set([...listFiles(base.path), ...listFiles(head.path)])].filter(inScope).sort();

  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  for (const rel of all) {
    const a = path.join(base.path, rel);
    const b = path.join(head.path, rel);
    const inA = fs.existsSync(a);
    const inB = fs.existsSync(b);
    const entry = { path: rel };

    if (inA && inB) {
      const blobA = blobOf(a);
      const blobB = blobOf(b);
      if (blobA === blobB) { files.push({ ...entry, status: 'identical' }); continue; }

      // Run from the shared parent so headers read as workspace-relative paths.
      let diff = '';
      const args = ['diff', '--no-index', '--no-color', '--', path.relative(root, a), path.relative(root, b)];
      try { diff = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { diff = err.stdout || ''; }
      const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
      const removed = (diff.match(/^-(?!--)/gm) || []).length;
      writeOut(dest, `diffs/${rel}.diff`, diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n… truncated (${diff.length} bytes)\n` : diff);

      // Does each side's current content appear in the other's history?
      const aSeenInB = findBlob(head.repo, head.revision, blobA);
      const bSeenInA = findBlob(base.repo, base.revision, blobB);
      const hint = aSeenInB && !bSeenInA ? `${base.alias}_behind`
        : bSeenInA && !aSeenInB ? `${head.alias}_behind`
          : aSeenInB && bSeenInA ? 'crossed' : 'diverged';

      files.push({
        ...entry, status: 'differs', added, removed,
        lines: { [base.alias]: lineCount(a), [head.alias]: lineCount(b) },
        blobs: { [base.alias]: blobA, [head.alias]: blobB },
        [`${base.alias}_content_in_${head.alias}_history`]: aSeenInB,
        [`${head.alias}_content_in_${base.alias}_history`]: bSeenInA,
        direction_hint: hint,
      });
    } else {
      const side = inA ? base : head;
      files.push({ ...entry, status: `only_in_${side.alias}`, lines: { [side.alias]: lineCount(inA ? a : b) } });
    }

    for (const side of [base, head]) {
      if (!fs.existsSync(path.join(side.path, rel))) continue;
      writeOut(dest, `history/${side.alias}/${rel}.log`, history(side.repo, side.revision, repoPath(side, rel)) + '\n');
    }
  }

  const count = s => files.filter(f => f.status === s).length;
  const manifest = {
    base: { alias: base.alias, revision: base.revision, subpath: base.subpath || null },
    head: { alias: head.alias, revision: head.revision, subpath: head.subpath || null },
    paths,
    summary: {
      files: files.length,
      identical: count('identical'),
      differs: count('differs'),
      [`only_in_${base.alias}`]: count(`only_in_${base.alias}`),
      [`only_in_${head.alias}`]: count(`only_in_${head.alias}`),
    },
    direction_hints: {
      [`${base.alias}_behind`]: `this side's content is in the other side's history: the other side moved past it`,
      [`${head.alias}_behind`]: `the reverse`,
      crossed: 'each side has held the other\'s content at some point',
      diverged: 'neither side ever held the other\'s current content',
    },
    files,
  };
  writeOut(dest, 'manifest.json', JSON.stringify(manifest, null, 2));
  execFileSync('chmod', ['-R', 'a-w', dest]);
  return manifest;
}

// The part of a manifest that says what drifted, and nothing else: every
// non-identical file with the content on each side. Two checks with the same
// signature saw the same drift, whatever the SHAs did elsewhere.
function signature(manifest) {
  return manifest.files
    .filter(f => f.status !== 'identical')
    .map(f => ({ path: f.path, status: f.status, ...(f.blobs ? { blobs: f.blobs } : {}) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// What changed between two signatures: files that started drifting, files
// whose drift changed content on either side, files back in sync.
function changes(prev = [], next = []) {
  const key = f => `${f.status}:${JSON.stringify(f.blobs || null)}`;
  const before = new Map(prev.map(f => [f.path, f]));
  const after = new Map(next.map(f => [f.path, f]));
  return {
    new: next.filter(f => !before.has(f.path)).map(f => f.path),
    changed: next.filter(f => before.has(f.path) && key(before.get(f.path)) !== key(f)).map(f => f.path),
    resolved: prev.filter(f => !after.has(f.path)).map(f => f.path),
  };
}

function writeOut(dest, rel, content) {
  const file = path.join(dest, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

module.exports = { compare, signature, changes, _internals: { blobOf, findBlob } };
