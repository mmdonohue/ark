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

// Running a laid-out USB through its launcher. Test bundles are built
// --skip-deps/--skip-node: NODE_PATH lends the repo's node_modules, and the
// host's node runs it. HOME is a scratch dir (the local unpack cache).
const { spawnSync } = require('child_process');
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function usbEnv(home, extra = {}) {
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, HOME: home, NODE_PATH: path.join(REPO, 'node_modules'), ...extra };
  for (const k of ['ARK_HOME', 'ARK_UPDATE_SOURCE', 'ARK_INSTALL_ROOT', 'ARK_RUNTIME_CACHE']) delete env[k];
  return env;
}
const launch = (usb, env, ...a) => spawnSync('sh', [path.join(usb, 'ark'), ...a], { env, cwd: TMP, encoding: 'utf8' });
const releaseOf = version => {
  const out = path.join(TMP, `rel-${version}`);
  if (!fs.existsSync(path.join(out, 'release.json'))) build(version, out);
  return { out, bundle: path.join(out, `ark-${version}-${PLATFORM}.tar.gz`) };
};
const newHome = name => { const h = path.join(TMP, `home-${name}`); fs.mkdirSync(h, { recursive: true }); return h; };

test('make-usb: a packed layout — one signed package per version, nothing unpacked yet', () => {
  const { bundle } = releaseOf('0.1.0');
  const usb = path.join(TMP, 'USB Drive'); // a space, like a real volume name
  assert.match(makeUsb(bundle, usb), /Verified 0\.1\.0 against release\.json, signed by test-key/);
  assert.deepEqual(fs.readdirSync(usb).sort(), ['Start ARK.cmd', 'Start ARK.command', 'ark', 'ark.cmd', 'ark.json', 'packages', 'runtime', 'vessels']);
  assert.deepEqual(fs.readdirSync(path.join(usb, 'packages')).sort(), [path.basename(bundle), `${path.basename(bundle)}.release.json`, `${path.basename(bundle)}.release.json.sig`].sort());
  assert.deepEqual(fs.readdirSync(path.join(usb, 'runtime')), ['current.json'], 'packed: nothing unpacked onto the drive');
  const cur = JSON.parse(fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8'));
  assert.deepEqual({ v: cur.version, p: cur.package, s: cur.sha256 }, { v: '0.1.0', p: path.basename(bundle), s: crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex') });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(usb, 'ark.json'), 'utf8')), { unpack: 'auto' });
  assert.equal(fs.statSync(path.join(usb, 'Start ARK.command')).mode & 0o111, 0o111, 'double-clickable on macOS');
  assert.match(fs.readFileSync(path.join(usb, 'Start ARK.command'), 'utf8'), /\.\/ark start/);
  assert.match(fs.readFileSync(path.join(usb, 'Start ARK.cmd'), 'utf8'), /ark\.cmd" start/);
  fails(() => makeUsb(bundle, usb), /already holds an ARK install — add a version with --upgrade/);
});

test('launcher: unpacks once on this computer, keeps your data on the drive, and checks the next release', () => {
  const { bundle } = releaseOf('0.1.0');
  const { out: out2 } = releaseOf('0.2.0');
  const usb = path.join(TMP, 'usb-host');
  makeUsb(bundle, usb);
  const home = newHome('host');
  const env = usbEnv(home);
  const sum = JSON.parse(fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8')).sha256;
  const cached = path.join(home, '.ark', 'runtime', `0.1.0-${sum.slice(0, 12)}`);

  const first = launch(usb, env, 'version');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /unpacking ARK 0\.1\.0 on this computer/);
  assert.match(first.stdout, /^ark 0\.1\.0 \(\w+\) · stable · portable install/m);
  assert.match(first.stdout, new RegExp(`^install  ${re(fs.realpathSync(usb))}$`, 'm'));
  assert.match(first.stdout, new RegExp(`^runtime  ${re(fs.realpathSync(cached))}$`, 'm'));
  assert.match(first.stdout, new RegExp(`^vessels  ${re(path.join(fs.realpathSync(usb), 'vessels'))}$`, 'm'), 'your data stays on the drive');
  assert.ok(fs.existsSync(path.join(cached, '.complete')));
  assert.deepEqual(fs.readdirSync(path.join(usb, 'runtime')), ['current.json'], 'nothing unpacked onto the drive');

  const again = launch(usb, env, 'version');
  assert.doesNotMatch(again.stderr, /unpacking/, 'only once per version');
  assert.match(launch(usb, env, 'update', '--check', '--source', out2).stdout, /Update available: 0\.1\.0 → 0\.2\.0 \(stable/);
  assert.deepEqual(fs.readdirSync(path.join(usb, 'vessels')), [], 'reading the runtime created no vessel');
  launch(usb, env, 'ls', 'note');
  assert.ok(fs.existsSync(path.join(usb, 'vessels', 'default', 'ark.sqlite')), 'a vessel lands on the drive');
  assert.ok(!fs.existsSync(path.join(home, '.ark', 'vessels')), 'never on the computer');

  // cleanup-host: other versions' copies go; the running one stays.
  const stale = path.join(home, '.ark', 'runtime', '0.0.9-aaaaaaaaaaaa');
  fs.mkdirSync(stale, { recursive: true });
  const clean = launch(usb, env, 'cleanup-host');
  assert.match(clean.stdout, /Removed from .*0\.0\.9-aaaaaaaaaaaa/);
  assert.match(clean.stdout, /Kept 0\.1\.0-\w{12} — it's running now/);
  assert.ok(!fs.existsSync(stale) && fs.existsSync(cached));
});

test('launcher: falls back to the drive when it can\'t write locally; "stick" mode; tampered and interrupted unpacks', () => {
  const { bundle } = releaseOf('0.1.0');

  // No writable home → unpacked onto the drive, once.
  const usb = path.join(TMP, 'usb-stick');
  makeUsb(bundle, usb);
  const ro = newHome('readonly');
  fs.chmodSync(ro, 0o555);
  try {
    const r = launch(usb, usbEnv(ro), 'version');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /unpacking ARK 0\.1\.0 onto this drive/);
    assert.match(r.stdout, new RegExp(`^runtime  ${re(path.join(fs.realpathSync(usb), 'runtime', '0.1.0'))}$`, 'm'));
    assert.ok(fs.existsSync(path.join(usb, 'runtime', '0.1.0', '.complete')));
    assert.doesNotMatch(launch(usb, usbEnv(ro), 'version').stderr, /unpacking/);
  } finally { fs.chmodSync(ro, 0o755); }

  // ark.json says stick: the drive, even with a writable home.
  const usb2 = path.join(TMP, 'usb-stickmode');
  node('make-usb.js', '--bundle', bundle, '--to', usb2, '--trust', TRUST, '--unpack', 'stick');
  const home = newHome('stickmode');
  assert.match(launch(usb2, usbEnv(home), 'version').stderr, /onto this drive/);
  assert.ok(!fs.existsSync(path.join(home, '.ark')), 'nothing left on this computer');

  // A leftover partial unpack and an incomplete version dir (no .complete)
  // are never used: the next launch unpacks cleanly.
  fs.rmSync(path.join(usb2, 'runtime', '0.1.0'), { recursive: true });
  fs.mkdirSync(path.join(usb2, 'runtime', '0.1.0.partial.123', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(usb2, 'runtime', '0.1.0', 'cli'), { recursive: true });
  const redo = launch(usb2, usbEnv(home), 'version');
  assert.equal(redo.status, 0, redo.stderr);
  assert.match(redo.stderr, /unpacking/);
  assert.ok(fs.existsSync(path.join(usb2, 'runtime', '0.1.0', '.complete')));

  // A package that no longer matches current.json is refused, nothing unpacked.
  const usb3 = path.join(TMP, 'usb-tamper');
  makeUsb(bundle, usb3);
  const pkg = path.join(usb3, 'packages', path.basename(bundle));
  const bytes = fs.readFileSync(pkg);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(pkg, bytes);
  const home3 = newHome('tamper');
  const bad = launch(usb3, usbEnv(home3), 'version');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not match the sha256 in current\.json - refusing to unpack it/);
  assert.ok(!fs.existsSync(path.join(home3, '.ark', 'runtime')) || !fs.readdirSync(path.join(home3, '.ark', 'runtime')).length);
});

test('make-usb --upgrade: adds a version, keeps the previous for rollback, never touches vessels (0.1.0\'s unpacked layout too)', () => {
  const { bundle: b1 } = releaseOf('0.1.0');
  const { bundle: b2 } = releaseOf('0.2.0');
  const usb = path.join(TMP, 'usb-upgrade');
  makeUsb(b1, usb);
  fs.mkdirSync(path.join(usb, 'vessels', 'default'), { recursive: true });
  fs.writeFileSync(path.join(usb, 'vessels', 'default', 'keep.txt'), 'mine');
  fs.writeFileSync(path.join(usb, 'ark.json'), JSON.stringify({ unpack: 'stick' }));

  assert.match(makeUsb(b2, usb, '--upgrade'), /ARK 0\.1\.0 → 0\.2\.0 on .* your vessels are untouched/);
  const cur = JSON.parse(fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8'));
  assert.equal(cur.version, '0.2.0');
  assert.deepEqual(Object.keys(cur.previous).sort(), ['package', 'sha256', 'version']);
  assert.equal(cur.previous.version, '0.1.0');
  assert.ok(fs.existsSync(path.join(usb, 'packages', path.basename(b1))), 'the previous package stays for rollback');
  assert.equal(fs.readFileSync(path.join(usb, 'vessels', 'default', 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(usb, 'ark.json'), 'utf8')), { unpack: 'stick' }, 'the owner\'s setting is kept');
  assert.match(launch(usb, usbEnv(newHome('upgrade')), 'version').stdout, /^ark 0\.2\.0 /m);
  // Launchers take the first "version": the active one precedes previous's,
  // and ark.cmd (not runnable here) keeps its first findstr match.
  const curText = fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8');
  assert.ok(curText.indexOf('"version"') < curText.indexOf('"previous"'));
  assert.match(fs.readFileSync(path.join(usb, 'ark.cmd'), 'utf8'), /do if not defined ARKV set ARKV=/);
  fails(() => makeUsb(b2, usb, '--upgrade'), /already runs ARK 0\.2\.0/);
  fails(() => makeUsb(b2, path.join(TMP, 'usb-none'), '--upgrade'), /holds no ARK install to upgrade/);

  // The earlier unpacked layout (runtime/0.1.0/ + current.json { version }).
  const legacy = path.join(TMP, 'usb-legacy');
  fs.mkdirSync(path.join(legacy, 'runtime'), { recursive: true });
  execFileSync('tar', ['-xzf', b1, '-C', path.join(legacy, 'runtime')]);
  fs.renameSync(path.join(legacy, 'runtime', 'ark-0.1.0'), path.join(legacy, 'runtime', '0.1.0'));
  fs.writeFileSync(path.join(legacy, 'runtime', 'current.json'), JSON.stringify({ version: '0.1.0' }));
  fs.mkdirSync(path.join(legacy, 'vessels'));
  makeUsb(b2, legacy, '--upgrade');
  const lc = JSON.parse(fs.readFileSync(path.join(legacy, 'runtime', 'current.json'), 'utf8'));
  assert.deepEqual([lc.version, lc.previous], ['0.2.0', { version: '0.1.0' }]);
  const env = usbEnv(newHome('legacy'));
  assert.match(launch(legacy, env, 'version').stdout, /^ark 0\.2\.0 /m);
  // Back to the unpacked 0.1.0 (what a rollback to it does): the new launcher runs it from the drive.
  fs.writeFileSync(path.join(legacy, 'runtime', 'current.json'), JSON.stringify({ version: '0.1.0' }));
  const back = launch(legacy, env, 'version');
  assert.match(back.stdout, /^ark 0\.1\.0 /m);
  assert.doesNotMatch(back.stderr, /unpacking/);
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
  // anything is written; a retry with the good bundle works.
  const bad = path.join(TMP, 'badbundle');
  const work = path.join(bad, 'work');
  fs.mkdirSync(work, { recursive: true });
  execFileSync('tar', ['-xzf', bundle, '-C', work]);
  fs.writeFileSync(path.join(work, 'ark-0.1.0', 'install.json'), JSON.stringify({ mode: 'portable', version: '9.9.9' }));
  const badTar = path.join(bad, path.basename(bundle));
  execFileSync('tar', ['-czf', badTar, '-C', work, 'ark-0.1.0']);
  const usbD = path.join(TMP, 'usb-d');
  fails(() => node('make-usb.js', '--bundle', badTar, '--to', usbD), /install\.json doesn't match its name/);
  assert.ok(!fs.existsSync(usbD), 'nothing written');
  makeUsb(bundle, usbD); // the good bundle into the same folder
  assert.equal(JSON.parse(fs.readFileSync(path.join(usbD, 'runtime', 'current.json'), 'utf8')).version, '0.1.0');
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
  const { bundle } = releaseOf('0.1.0');
  const usb = path.join(TMP, 'usb-launch');
  node('make-usb.js', '--bundle', bundle, '--to', usb, '--trust', TRUST, '--unpack', 'stick');
  const home = newHome('launch');
  assert.equal(launch(usb, usbEnv(home), 'version').status, 0); // first run unpacks onto the drive
  // A stand-in bundled node: leaves a mark, then hands over to this Node.
  const rt = path.join(usb, 'runtime', '0.1.0');
  const marker = path.join(TMP, 'bundled-node-ran');
  fs.mkdirSync(path.join(rt, 'node', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'node', 'bin', 'node'), `#!/bin/sh\ntouch "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const r = launch(usb, usbEnv(home, { PATH: '/usr/bin:/bin' }), 'version'); // no Node on PATH at all
  assert.match(r.stdout, /^ark 0\.1\.0 /m, r.stderr);
  assert.ok(fs.existsSync(marker), 'the bundled node ran, not one from PATH');
});
