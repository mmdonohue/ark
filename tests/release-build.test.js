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

const node = (script, ...args) => execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], { encoding: 'utf8', stdio: 'pipe' });
const build = (version, out) => node('release-build.js', '--out', out, '--version', version, '--channel', 'stable', '--notes', `ARK ${version}`,
  '--trust', TRUST, '--key', KEY, '--key-id', 'test-key', '--skip-deps');

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
  node('make-usb.js', '--bundle', path.join(out1, `ark-0.1.0-${PLATFORM}.tar.gz`), '--to', usb);
  assert.deepEqual(fs.readdirSync(usb).sort(), ['ark', 'ark.cmd', 'runtime', 'vessels']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(usb, 'runtime', 'current.json'), 'utf8')).version, '0.1.0');
  assert.throws(() => node('make-usb.js', '--bundle', path.join(out1, `ark-0.1.0-${PLATFORM}.tar.gz`), '--to', usb), /already holds an ARK install/);

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
