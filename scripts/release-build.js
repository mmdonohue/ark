#!/usr/bin/env node
'use strict';

// Builds a signed ARK release bundle for THIS platform — run by the release
// publisher, never by a runtime.
//
//   node scripts/release-build.js --out <dir> [--version x.y.z] [--channel stable]
//        [--notes "…"] [--source-url <url>] [--trust <release-keys.json>]
//        [--key <private.pem> --key-id <id>] [--skip-deps]
//
// 1. Copies the runtime's tracked files (git ls-files) — never vessels
//    (arks/), .env, node_modules or anything untracked.
// 2. Installs production dependencies for this platform (npm ci --omit=dev):
//    better-sqlite3 and sharp are native, so a bundle is per <os>-<arch>.
//    --skip-deps leaves them out (tests, dry runs).
// 3. Writes install.json: { mode: 'portable', version, channel, build,
//    data_root: '../../vessels', update_source }.
// 4. Tars it as ark-<version>-<os>-<arch>.tar.gz and records its sha256 and
//    size in <out>/release.json — merged with an existing manifest for the
//    same version, so other platforms' bundles can be added to one release.
// 5. Signs release.json (release.json.sig) when given --key/--key-id.
//
// --trust replaces the bundle's trust/release-keys.json: the keys this
// bundle will trust for its own future updates.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const release = require('../utils/release');

const REPO = path.resolve(__dirname, '..');
// Tracked, but not part of a runtime: example vessels, CI config.
const EXCLUDE = [/^arks\//, /^\.github\//, /^\.gitignore$/];

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
const flag = name => process.argv.includes(name);
function fail(msg) { console.error(msg); process.exit(1); }
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
  const stage = path.join(outDir, '.stage', name);
  fs.rmSync(path.join(outDir, '.stage'), { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // 1. Tracked runtime files.
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  let copied = 0;
  for (const rel of tracked) {
    if (EXCLUDE.some(re => re.test(rel))) continue;
    const src = path.join(REPO, rel);
    if (!fs.existsSync(src) || fs.lstatSync(src).isSymbolicLink()) continue;
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.copyFileSync(src, path.join(stage, rel));
    copied++;
  }
  if (arg('--trust')) fs.copyFileSync(path.resolve(arg('--trust')), path.join(stage, 'trust', 'release-keys.json'));

  // 2. Production dependencies for this platform.
  if (!flag('--skip-deps')) {
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  }

  // 3. install.json.
  let build = null;
  try { build = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const install = { mode: 'portable', version, channel, build, data_root: '../../vessels', update_source: arg('--source-url') || null };
  fs.writeFileSync(path.join(stage, 'install.json'), JSON.stringify(install, null, 2));

  // 4. Tarball + manifest.
  const tarball = path.join(outDir, file);
  execFileSync('tar', ['-czf', tarball, '-C', path.dirname(stage), name]);
  fs.rmSync(path.join(outDir, '.stage'), { recursive: true, force: true });

  const manifestPath = path.join(outDir, 'release.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first platform */ }
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

  console.log(`${file}: ${copied} files${flag('--skip-deps') ? ' (no node_modules)' : ''}, ${manifest.platforms[platform].size} bytes`);
  console.log(`release.json: ${version} (${Object.keys(manifest.platforms).join(', ')})${arg('--key') ? `, signed by ${arg('--key-id')}` : ', UNSIGNED'}`);
}

main();
