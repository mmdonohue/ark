'use strict';

// Release bundles and a USB-like portable install: build → sign → lay out →
// run through the launcher → check for the next release.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const release = require('../utils/release');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-release-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PLATFORM = release.platformKey();
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const KEY = path.join(TMP, 'test.private.pem');
fs.writeFileSync(KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }));
const TRUST = path.join(TMP, 'release-keys.json');
const ENTRY = { id: 'test-key', public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
fs.writeFileSync(TRUST, JSON.stringify([ENTRY]));

// Builds come from a disposable clone: a clean tree at a known commit,
// whatever state this checkout is in.
const CLONE = path.join(TMP, 'clone');
execFileSync('git', ['clone', '-q', REPO, CLONE]);
const g = (...a) => execFileSync('git', ['-C', CLONE, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: 'pipe' });

const node = (script, ...args) => execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], { encoding: 'utf8', stdio: 'pipe' });
const build = (version, out, ...extra) => node('release-build.js', '--repo', CLONE, '--out', out, '--version', version, '--channel', 'stable', '--notes', `ARK ${version}`,
  '--trust', TRUST, '--key', KEY, '--key-id', 'test-key', '--skip-deps', '--skip-node', ...extra);
const makeUsb = (bundle, to, ...extra) => node('make-usb.js', '--bundle', bundle, '--to', to, '--trust', TRUST, ...extra);
const fails = (fn, re) => assert.throws(fn, err => re.test(String(err.stderr || err.message)), String(re));

test('release-build: tracked runtime files only, install.json, a signed manifest that verifies', () => {
  const out = path.join(TMP, 'r010');
  build('0.1.0', out);
  const file = `ark-0.1.0-${PLATFORM}.tar.gz`;
  const listing = execFileSync('tar', ['-tzf', path.join(out, file)], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(listing.includes('ark-0.1.0/cli/ark.js'));
  assert.ok(listing.includes('ark-0.1.0/install.json'));
  assert.ok(listing.includes('ark-0.1.0/trust/release-keys.json'));
  for (const never of [/^ark-0\.1\.0\/arks\//, /\.env$/, /node_modules\//, /\.sqlite/]) {
    assert.ok(!listing.some(f => never.test(f)), `bundle must not contain ${never}`);
  }

  const bytes = fs.readFileSync(path.join(out, 'release.json'));
  const m = JSON.parse(bytes);
  assert.equal(release.manifestError(m), null);
  assert.deepEqual({ version: m.version, channel: m.channel, min_node: m.min_node, notes: m.notes }, { version: '0.1.0', channel: 'stable', min_node: '18.0.0', notes: 'ARK 0.1.0' });
  const b = m.platforms[PLATFORM];
  assert.equal(b.file, file);
  assert.equal(b.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex'));
  assert.equal(b.size, fs.statSync(path.join(out, file)).size);
  assert.equal(release.verifySignature(bytes, fs.readFileSync(path.join(out, 'release.json.sig')), [ENTRY]), 'test-key');

  // The bundle's install.json and trust list.
  const x = path.join(TMP, 'x010');
  fs.mkdirSync(x);
  execFileSync('tar', ['-xzf', path.join(out, file), '-C', x]);
  const install = JSON.parse(fs.readFileSync(path.join(x, 'ark-0.1.0', 'install.json'), 'utf8'));
  assert.deepEqual({ mode: install.mode, version: install.version, channel: install.channel, data_root: install.data_root },
    { mode: 'portable', version: '0.1.0', channel: 'stable', data_root: '../../vessels' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x, 'ark-0.1.0', 'trust', 'release-keys.json'), 'utf8')), [ENTRY]);
});

test('make-usb + launcher: a portable install runs, keeps vessels beside the runtime, and finds the next signed release', () => {
  const out1 = path.join(TMP, 'u010');
  const out2 = path.join(TMP, 'u020');
  build('0.1.0', out1);
  build('0.2.0', out2);
  const usb = path.join(TMP, 'USB Drive'); // a space, like a real volume name
  assert.match(makeUsb(path.join(out1, `ark-0.1.0-${PLATFORM}.tar.gz`), usb), /Verified 0\.1\.0 against release\.json, signed by test-key/);
  assert.deepEqual(fs.readdirSync(usb).sort(), ['ark', 'ark.cmd', 'runtime', 'vessels']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8')).version, '0.1.0');
  fails(() => makeUsb(path.join(out1, `ark-0.1.0-${PLATFORM}.tar.gz`), usb), /already holds an ARK install/);

  // --skip-deps bundles have no node_modules; borrow the repo's to run it.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(usb, 'runtime', '0.1.0', 'node_modules'));
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  delete env.ARK_HOME;
  delete env.ARK_UPDATE_SOURCE;
  const ark = (...a) => execFileSync('sh', [path.join(usb, 'ark'), ...a], { env, cwd: TMP, encoding: 'utf8', stdio: 'pipe' });

  const v = ark('version');
  assert.match(v, /^ark 0\.1\.0 \(\w+\) · stable · portable install/m);
  assert.match(v, new RegExp(`vessels  ${path.join(fs.realpathSync(usb), 'vessels').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); // /tmp → /private/tmp on macOS
  assert.match(ark('update', '--check', '--source', out2), /Update available: 0\.1\.0 → 0\.2\.0 \(stable/);
  assert.match(ark('update', '--check', '--source', out1), /Up to date: 0\.1\.0/);
  assert.deepEqual(fs.readdirSync(path.join(usb, 'vessels')), [], 'reading the runtime created no vessel');

  // A vessel is created in vessels/, never in the runtime.
  ark('ls', 'note');
  assert.ok(fs.existsSync(path.join(usb, 'vessels', 'default', 'ark.sqlite')));
  assert.ok(!fs.existsSync(path.join(usb, 'runtime', '0.1.0', 'arks')));
});

test('release-build: the bundle is the commit — a dirty tree is refused, --allow-dirty still builds HEAD', () => {
  const out = path.join(TMP, 'dirty');
  const target = path.join(CLONE, 'cli', 'ark.js');
  const committed = fs.readFileSync(target, 'utf8');
  fs.appendFileSync(target, '\n// UNCOMMITTED EDIT\n');
  try {
    fails(() => build('0.3.0', out), /uncommitted changes to tracked files[\s\S]*cli\/ark\.js/);
    assert.ok(!fs.existsSync(path.join(out, 'release.json')), 'nothing built');
    const warned = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'release-build.js'), '--repo', CLONE, '--out', out, '--version', '0.3.0',
      '--trust', TRUST, '--skip-deps', '--skip-node', '--allow-dirty'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(warned, /from \w{12}/);
    const x = path.join(TMP, 'x-dirty');
    fs.mkdirSync(x);
    execFileSync('tar', ['-xzf', path.join(out, `ark-0.3.0-${PLATFORM}.tar.gz`), '-C', x]);
    assert.equal(fs.readFileSync(path.join(x, 'ark-0.3.0', 'cli', 'ark.js'), 'utf8'), committed, 'HEAD as committed, not the edit');
    const install = JSON.parse(fs.readFileSync(path.join(x, 'ark-0.3.0', 'install.json'), 'utf8'));
    assert.equal(install.build, g('rev-parse', '--short=12', 'HEAD').trim(), 'install.json names that commit');
  } finally {
    fs.writeFileSync(target, committed);
  }
  // Untracked files never matter (and never ship).
  fs.writeFileSync(path.join(CLONE, 'scratch.txt'), 'local');
  build('0.3.1', path.join(TMP, 'untracked'));
  const listing = execFileSync('tar', ['-tzf', path.join(TMP, 'untracked', `ark-0.3.1-${PLATFORM}.tar.gz`)], { encoding: 'utf8' });
  assert.ok(!listing.includes('scratch.txt'));
  fs.rmSync(path.join(CLONE, 'scratch.txt'));
});

test('release-build: a second platform joins the same release; a different channel or notes is refused', () => {
  const out = path.join(TMP, 'multi');
  build('0.4.0', out);
  // Another platform's bundle, as if built on that machine.
  const m = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
  m.platforms['linux-x64'] = { file: 'ark-0.4.0-linux-x64.tar.gz', sha256: 'c'.repeat(64), size: 99 };
  fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(m));
  build('0.4.0', out);
  const merged = JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8'));
  assert.deepEqual(Object.keys(merged.platforms).sort(), ['linux-x64', PLATFORM].sort(), 'both platforms in one release');
  assert.equal(merged.released_at, m.released_at, 'same release, not a new one');
  assert.equal(release.verifySignature(fs.readFileSync(path.join(out, 'release.json')), fs.readFileSync(path.join(out, 'release.json.sig')), [ENTRY]), 'test-key', 're-signed after the merge');

  fails(() => node('release-build.js', '--repo', CLONE, '--out', out, '--version', '0.4.0', '--channel', 'beta', '--skip-deps', '--skip-node'), /is channel "stable", not "beta"/);
  fails(() => node('release-build.js', '--repo', CLONE, '--out', out, '--version', '0.4.0', '--notes', 'something else', '--skip-deps', '--skip-node'), /already has different notes/);
  // A new version starts a new manifest.
  build('0.5.0', out);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'release.json'), 'utf8')).platforms), [PLATFORM]);
});

test('make-usb: verifies against a sibling release, cleans up on failure, and a retry works', () => {
  const out = path.join(TMP, 'm010');
  build('0.1.0', out);
  const bundle = path.join(out, `ark-0.1.0-${PLATFORM}.tar.gz`);

  // Tampered bytes → sha256 mismatch → refused, nothing laid out.
  const tampered = path.join(TMP, 'tampered');
  fs.mkdirSync(tampered);
  for (const f of ['release.json', 'release.json.sig']) fs.copyFileSync(path.join(out, f), path.join(tampered, f));
  const tb = path.join(tampered, path.basename(bundle));
  const bytes = fs.readFileSync(bundle);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(tb, bytes);
  const usbA = path.join(TMP, 'usb-a');
  fails(() => makeUsb(tb, usbA), /doesn't match release\.json's sha256|bytes; release\.json says/);
  assert.ok(!fs.existsSync(usbA), 'nothing created');
  // An untrusted signature → refused.
  fails(() => node('make-usb.js', '--bundle', bundle, '--to', path.join(TMP, 'usb-b'), '--trust', path.join(TMP, 'nobody.json')), /ENOENT|not signed by a trusted key/);
  fs.writeFileSync(path.join(TMP, 'nobody.json'), '[]');
  fails(() => node('make-usb.js', '--bundle', bundle, '--to', path.join(TMP, 'usb-b'), '--trust', path.join(TMP, 'nobody.json')), /not signed by a trusted key/);

  // A bundle with no release beside it is laid out, with a warning.
  const loose = path.join(TMP, 'loose');
  fs.mkdirSync(loose);
  fs.copyFileSync(bundle, path.join(loose, path.basename(bundle)));
  const r = require('child_process').spawnSync(process.execPath, [path.join(REPO, 'scripts', 'make-usb.js'), '--bundle', path.join(loose, path.basename(bundle)), '--to', path.join(TMP, 'usb-c')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /NOT verified/);

  // install.json that doesn't match the bundle's name → refused before
  // anything moves into place; the folder is as it was, and a retry works.
  const bad = path.join(TMP, 'badbundle');
  const work = path.join(bad, 'work');
  fs.mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', bundle, '-C', work]);
  fs.writeFileSync(path.join(work, 'ark-0.1.0', 'install.json'), JSON.stringify({ mode: 'portable', version: '9.9.9' }));
  const badTar = path.join(bad, path.basename(bundle));
  execFileSync('tar', ['-czf', badTar, '-C', work, 'ark-0.1.0']);
  const usbD = path.join(TMP, 'usb-d');
  fails(() => node('make-usb.js', '--bundle', badTar, '--to', usbD), /install\.json doesn't match its name[\s\S]*unchanged/);
  assert.ok(!fs.existsSync(path.join(usbD, 'runtime')), 'no partial runtime left behind');
  makeUsb(bundle, usbD); // the good bundle into the same folder
  assert.equal(JSON.parse(fs.readFileSync(path.join(usbD, 'runtime', 'current.json'), 'utf8')).version, '0.1.0');

  // A leftover partial version dir is named, not an ENOTEMPTY.
  const usbE = path.join(TMP, 'usb-e');
  fs.mkdirSync(path.join(usbE, 'runtime', '0.1.0'), { recursive: true });
  fails(() => makeUsb(bundle, usbE), /already exists without an active install/);
});

test('bundled Node: the pin is complete, downloads are named as nodejs.org names them', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(REPO, 'trust', 'node.json'), 'utf8'));
  assert.ok(release.isVersion(pin.version));
  assert.equal(pin.version.split('.')[0], '24', 'Node 24 LTS (EOL 2028-04-30) — moving majors is a reviewed change');
  assert.match(String(pin.modules), /^\d+$/);
  assert.match(pin.source, /^https:\/\/nodejs\.org\/dist\/$/);
  for (const p of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']) assert.match(pin.sha256[p], /^[0-9a-f]{64}$/, p);
  assert.deepEqual(release.nodeDist('24.22.3', 'darwin-arm64'), { name: 'node-v24.22.3-darwin-arm64', file: 'node-v24.22.3-darwin-arm64.tar.gz', binary: 'bin/node' });
  assert.deepEqual(release.nodeDist('24.22.3', 'win32-x64'), { name: 'node-v24.22.3-win-x64', file: 'node-v24.22.3-win-x64.zip', binary: 'node.exe' });
});

test('bundled Node: the manifest says which; the host\'s Node then doesn\'t matter', async () => {
  const base = { name: 'ark', version: '0.2.0', channel: 'stable', released_at: '2026-11-25T00:00:00Z', min_node: '18.0.0' };
  const entry = { file: `ark-0.2.0-${PLATFORM}.tar.gz`, sha256: 'd'.repeat(64), size: 10 };
  assert.equal(release.manifestError({ ...base, platforms: { [PLATFORM]: { ...entry, node: '24.22.3', node_abi: '137' } } }), null);
  assert.match(String(release.manifestError({ ...base, platforms: { [PLATFORM]: { ...entry, node: '24.22.3' } } })), /go together/);
  assert.match(String(release.manifestError({ ...base, platforms: { [PLATFORM]: { ...entry, node: '24', node_abi: '137' } } })), /node must be x\.y\.z/);

  const dir = path.join(TMP, 'bundled-node-release');
  fs.mkdirSync(dir);
  const publish = m => {
    const bytes = Buffer.from(JSON.stringify(m));
    fs.writeFileSync(path.join(dir, 'release.json'), bytes);
    fs.writeFileSync(path.join(dir, 'release.json.sig'), release.signManifest(bytes, fs.readFileSync(KEY), 'test-key'));
  };
  publish({ ...base, min_node: '99.0.0', platforms: { [PLATFORM]: { ...entry, node: '24.22.3', node_abi: '137' } } });
  const r = await release.check({ source: dir, current: '0.1.0', keys: [ENTRY], nodeVersion: '18.20.8' });
  assert.deepEqual([r.status, r.latest.bundle.node], ['available', '24.22.3'], 'carries its own Node: the host\'s 18 is irrelevant');
  publish({ ...base, min_node: '99.0.0', platforms: { [PLATFORM]: entry } });
  assert.equal((await release.check({ source: dir, current: '0.1.0', keys: [ENTRY], nodeVersion: '18.20.8' })).status, 'incompatible_node', 'without one, min_node still applies');
});

test('the launcher runs the Node bundled in the active version', () => {
  const out = path.join(TMP, 'launch');
  build('0.1.0', out);
  const usb = path.join(TMP, 'usb-launch');
  makeUsb(path.join(out, `ark-0.1.0-${PLATFORM}.tar.gz`), usb);
  const rt = path.join(usb, 'runtime', '0.1.0');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(rt, 'node_modules'));
  // A stand-in bundled node: leaves a mark, then hands over to this Node.
  const marker = path.join(TMP, 'bundled-node-ran');
  fs.mkdirSync(path.join(rt, 'node', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'node', 'bin', 'node'), `#!/bin/sh\ntouch "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: '/usr/bin:/bin' }; // no Node on PATH at all
  delete env.ARK_HOME;
  const out1 = execFileSync('sh', [path.join(usb, 'ark'), 'version'], { env, cwd: TMP, encoding: 'utf8', stdio: 'pipe' });
  assert.match(out1, /^ark 0\.1\.0 /m);
  assert.ok(fs.existsSync(marker), 'the bundled node ran, not one from PATH');
});
