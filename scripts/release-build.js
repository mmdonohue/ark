#!/usr/bin/env node
'use strict';

// Builds a signed ARK release bundle for THIS platform — run by the release
// publisher, never by a runtime.
//
//   node scripts/release-build.js --out <dir> [--version x.y.z] [--channel stable]
//        [--notes "…"] [--source-url <url>] [--trust <release-keys.json>]
//        [--key <private.pem> --key-id <id>] [--skip-deps] [--skip-node]
//        [--node-cache <dir>] [--repo <checkout>] [--allow-dirty]
//
// 1. Takes the runtime from the committed tree (git archive HEAD), so a
//    bundle is exactly the commit install.json names — never uncommitted
//    edits, vessels (arks/), .env, node_modules or anything untracked.
//    Refuses a dirty working tree unless --allow-dirty (which still builds
//    HEAD, and says so).
// 2. Bundles Node: the version pinned in trust/node.json, downloaded from
//    nodejs.org for this platform and checked against the sha256 pinned
//    there (cached in --node-cache). Only its node binary and LICENSE ship,
//    in node/. Whoever runs the bundle needs no Node of their own.
//    --skip-node leaves it out (tests): the host's Node runs it.
// 3. Installs production dependencies with THAT Node's own npm
//    (npm ci --omit=dev), so native modules (better-sqlite3, sharp) are
//    built for the ABI that ships. A bundle is per <os>-<arch>.
//    --skip-deps leaves them out (tests, dry runs).
// 4. Writes install.json: { mode: 'portable', version, channel, build, node, data_format,
//    data_root: '../../vessels', update_source }.
// 5. Tars it as ark-<version>-<os>-<arch>.tar.gz and records its sha256,
//    size, node and node_abi in <out>/release.json — merged with an existing
//    manifest for the same version, so other platforms' bundles can be added
//    to one release (a different --channel or --notes for it is refused).
// 6. Signs release.json (release.json.sig) when given --key/--key-id.
//
// --trust replaces the bundle's trust/release-keys.json: the keys this
// bundle will trust for its own future updates.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const release = require('../utils/release');

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
const flag = name => process.argv.includes(name);
function fail(msg) { console.error(msg); process.exit(1); }
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const REPO = path.resolve(arg('--repo') || path.join(__dirname, '..'));
// Committed, but not part of a runtime: example vessels, CI config.
const EXCLUDE = ['arks', '.github', '.gitignore'];

// The pinned Node for this platform: downloaded once, verified every time.
async function pinnedNode(platform) {
  const pin = JSON.parse(fs.readFileSync(path.join(REPO, 'trust', 'node.json'), 'utf8'));
  const expected = pin.sha256?.[platform];
  if (!expected) fail(`trust/node.json pins no Node ${pin.version} for ${platform}`);
  if (platform.startsWith('win32')) fail('Windows bundles aren\'t built yet (they need a zip extract and a node.exe launcher test).');
  const dist = release.nodeDist(pin.version, platform);
  const cache = path.resolve(arg('--node-cache') || path.join(os.homedir(), '.cache', 'ark', 'node'));
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, dist.file);
  if (!fs.existsSync(archive) || sha256(archive) !== expected) {
    const url = `${pin.source}v${pin.version}/${dist.file}`;
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) fail(`${url}: HTTP ${res.status}`);
    const part = `${archive}.part`;
    fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    if (sha256(part) !== expected) { fs.rmSync(part, { force: true }); fail(`${dist.file} doesn't match the sha256 pinned in trust/node.json — refusing.`); }
    fs.renameSync(part, archive);
  }
  const home = path.join(cache, dist.name);
  if (!fs.existsSync(path.join(home, dist.binary))) execFileSync('tar', ['-xzf', archive, '-C', cache]);
  const bin = path.join(home, dist.binary);
  const abi = execFileSync(bin, ['-p', 'process.versions.modules'], { encoding: 'utf8' }).trim();
  if (abi !== String(pin.modules)) fail(`Node ${pin.version} reports ABI ${abi}; trust/node.json says ${pin.modules}`);
  return { version: pin.version, abi, home, bin, dist };
}

async function main() {
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

  // 2. Node, bundled.
  const node = flag('--skip-node') ? null : await pinnedNode(platform);
  if (node) {
    const dest = path.join(stage, 'node', node.dist.binary);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(node.bin, dest);
    fs.chmodSync(dest, 0o755);
    fs.copyFileSync(path.join(node.home, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));
  }

  // 3. Production dependencies, built by the Node that ships.
  if (!flag('--skip-deps')) {
    const npm = node ? [node.bin, path.join(node.home, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : ['npm'];
    const env = node ? { ...process.env, PATH: `${path.dirname(node.bin)}${path.delimiter}${process.env.PATH}` } : process.env;
    execFileSync(npm[0], [...npm.slice(1), 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, env, stdio: 'inherit' });
    // The native modules really load on the Node that ships — not just
    // "npm ci exited 0" (an install script skipped by npm policy would
    // otherwise surface only on someone else's machine).
    try {
      execFileSync(node ? node.bin : process.execPath, ['-e',
        "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); require('sharp');"],
      { cwd: stage, stdio: 'pipe' });
    } catch (err) {
      fail(`The bundle's native modules don't load on ${node ? `Node ${node.version}` : 'this Node'}:\n${String(err.stderr || err.message).slice(0, 2000)}`);
    }
  }

  // 4. install.json.
  const build = execFileSync('git', ['-C', REPO, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  // The data format the bundled code reads (its own utils/dataFormat.js, not
  // this script's): a rollback checks it against the vessels first.
  let dataFormat = null;
  try { dataFormat = require(path.join(stage, 'utils', 'dataFormat.js')).DATA_FORMAT; } catch { /* a tree from before the guard */ }
  const install = { mode: 'portable', version, channel, build, ...(node ? { node: node.version } : {}),
    ...(Number.isInteger(dataFormat) ? { data_format: dataFormat } : {}),
    data_root: '../../vessels', update_source: arg('--source-url') || null };
  fs.writeFileSync(path.join(stage, 'install.json'), JSON.stringify(install, null, 2));

  // 5. Tarball + manifest.
  const tarball = path.join(outDir, file);
  // COPYFILE_DISABLE: no macOS ._ metadata entries in the package (they'd
  // double the file count wherever it's unpacked on FAT/exFAT).
  execFileSync('tar', ['-czf', tarball, '-C', stageRoot, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.rmSync(stageRoot, { recursive: true, force: true });

  if (!manifest || manifest.version !== version) {
    // min_node only matters for a bundle that runs on the host's Node.
    const minNode = /(\d+)/.exec(pkg.engines?.node || '')?.[1];
    manifest = {
      name: 'ark', version, channel, released_at: new Date().toISOString(),
      ...(minNode ? { min_node: `${minNode}.0.0` } : {}),
      ...(arg('--notes') ? { notes: arg('--notes') } : {}),
      platforms: {},
    };
  }
  manifest.platforms[platform] = { file, sha256: sha256(tarball), size: fs.statSync(tarball).size,
    ...(node ? { node: node.version, node_abi: node.abi } : {}) };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const bad = release.manifestError(manifest);
  if (bad) fail(`release.json: ${bad}`);
  fs.writeFileSync(manifestPath, bytes);
  fs.rmSync(path.join(outDir, 'release.json.sig'), { force: true }); // stale once the manifest changed

  // 6. Signature.
  if (arg('--key')) {
    if (!arg('--key-id')) fail('--key needs --key-id');
    fs.writeFileSync(path.join(outDir, 'release.json.sig'), release.signManifest(bytes, fs.readFileSync(arg('--key')), arg('--key-id')));
  }

  const extras = [node ? `node ${node.version}` : 'no bundled node', flag('--skip-deps') ? 'no node_modules' : null].filter(Boolean).join(', ');
  console.log(`${file}: ${files} files from ${build} (${extras}), ${manifest.platforms[platform].size} bytes`);
  console.log(`release.json: ${version} (${Object.keys(manifest.platforms).join(', ')})${arg('--key') ? `, signed by ${arg('--key-id')}` : ', UNSIGNED'}`);
}

main().catch(err => fail(err.stack || err.message));
