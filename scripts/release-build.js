#!/usr/bin/env node
'use strict';

// Builds a signed ARK release bundle for THIS platform — run by the release
// publisher, never by a runtime.
//
//   node scripts/release-build.js --out <dir> [--version x.y.z] [--channel stable]
//        [--notes "…"] [--source-url <url>] [--trust <release-keys.json>]
//        [--key <private.pem> --key-id <id>] [--skip-deps]
//        [--repo <checkout>] [--allow-dirty]
//
// 1. Takes the runtime from the committed tree (git archive HEAD), so a
//    bundle is exactly the commit install.json names — never uncommitted
//    edits, vessels (arks/), .env, node_modules or anything untracked.
//    Refuses a dirty working tree unless --allow-dirty (which still builds
//    HEAD, and says so).
// 2. Installs production dependencies for this platform (npm ci --omit=dev):
//    better-sqlite3 and sharp are native, so a bundle is per <os>-<arch>.
//    --skip-deps leaves them out (tests, dry runs).
// 3. Writes install.json: { mode: 'portable', version, channel, build,
//    data_root: '../../vessels', update_source }.
// 4. Tars it as ark-<version>-<os>-<arch>.tar.gz and records its sha256 and
//    size in <out>/release.json — merged with an existing manifest for the
//    same version, so other platforms' bundles can be added to one release
//    (a different --channel or --notes for that version is refused).
// 5. Signs release.json (release.json.sig) when given --key/--key-id.
//
// --trust replaces the bundle's trust/release-keys.json: the keys this
// bundle will trust for its own future updates.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const release = require('../utils/release');

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
const flag = name => process.argv.includes(name);
function fail(msg) { console.error(msg); process.exit(1); }
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const REPO = path.resolve(arg('--repo') || path.join(__dirname, '..'));
// Committed, but not part of a runtime: example vessels, CI config.
const EXCLUDE = ['arks', '.github', '.gitignore'];

function main() {
  const out = arg('--out');
  if (!out) fail('--out <dir> is required');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const version = arg('--version') || pkg.version;
  const channel = arg('--channel') || 'stable';
  if (!release.isVersion(version)) fail(`version "${version}" isn't x.y.z`);
  const platform = release.platformKey();
  const name = `ark-${version}`;
  const file = `${name}-${platform}.tar.gz`;

  const outDir = path.resolve(out);
  const manifestPath = path.join(outDir, 'release.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first platform */ }
  if (manifest && manifest.version === version) {
    // Adding a platform to this release: it must be the same release.
    if (manifest.channel !== channel) fail(`release.json for ${version} is channel "${manifest.channel}", not "${channel}"`);
    if (arg('--notes') && arg('--notes') !== manifest.notes) fail(`release.json for ${version} already has different notes — one release, one set of notes`);
  }

  // 1. The committed tree at HEAD — what install.json's build names.
  const dirty = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty && !flag('--allow-dirty')) {
    fail(`The working tree has uncommitted changes to tracked files:\n${dirty}\nCommit them, or pass --allow-dirty to build HEAD without them.`);
  }
  if (dirty) console.warn('warning: uncommitted changes are NOT in this bundle — it is HEAD as committed.');
  const stageRoot = path.join(outDir, '.stage');
  const stage = path.join(stageRoot, name);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  // Through a file, not a pipe (bsdtar can exit before git archive's padding — see utils/snapshot.js).
  const archive = path.join(stageRoot, 'head.tar');
  execFileSync('git', ['-C', REPO, 'archive', '--format=tar', `--output=${archive}`, 'HEAD']);
  execFileSync('tar', ['-xf', archive, '-C', stage]);
  fs.rmSync(archive, { force: true });
  for (const rel of EXCLUDE) fs.rmSync(path.join(stage, rel), { recursive: true, force: true });
  const count = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
  const files = count(stage);
  if (arg('--trust')) fs.copyFileSync(path.resolve(arg('--trust')), path.join(stage, 'trust', 'release-keys.json'));

  // 2. Production dependencies for this platform.
  if (!flag('--skip-deps')) {
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  }

  // 3. install.json.
  const build = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  const install = { mode: 'portable', version, channel, build, data_root: '../../vessels', update_source: arg('--source-url') || null };
  fs.writeFileSync(path.join(stage, 'install.json'), JSON.stringify(install, null, 2));

  // 4. Tarball + manifest.
  const tarball = path.join(outDir, file);
  execFileSync('tar', ['-czf', tarball, '-C', stageRoot, name]);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  if (!manifest || manifest.version !== version) {
    const minNode = /^(\d+)/.exec(pkg.engines?.node || '')?.[1];
    manifest = {
      name: 'ark', version, channel, released_at: new Date().toISOString(),
      ...(minNode ? { min_node: `${minNode}.0.0` } : {}),
      ...(arg('--notes') ? { notes: arg('--notes') } : {}),
      platforms: {},
    };
  }
  manifest.platforms[platform] = { file, sha256: sha256(tarball), size: fs.statSync(tarball).size };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const bad = release.manifestError(manifest);
  if (bad) fail(`release.json: ${bad}`);
  fs.writeFileSync(manifestPath, bytes);
  fs.rmSync(path.join(outDir, 'release.json.sig'), { force: true }); // stale once the manifest changed

  // 5. Signature.
  if (arg('--key')) {
    if (!arg('--key-id')) fail('--key needs --key-id');
    fs.writeFileSync(path.join(outDir, 'release.json.sig'), release.signManifest(bytes, fs.readFileSync(arg('--key')), arg('--key-id')));
  }

  console.log(`${file}: ${files} files from ${build}${flag('--skip-deps') ? ' (no node_modules)' : ''}, ${manifest.platforms[platform].size} bytes`);
  console.log(`release.json: ${version} (${Object.keys(manifest.platforms).join(', ')})${arg('--key') ? `, signed by ${arg('--key-id')}` : ', UNSIGNED'}`);
}

main();
