'use strict';

// The installation layout: vessels live outside the runtime an update
// replaces (utils/arkHome.js).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = require('../utils/arkHome');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-runtime-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A portable layout: <usb>/runtime/<version>/ (code) and <usb>/vessels/.
function portable(installJson) {
  const usb = fs.mkdtempSync(path.join(TMP, 'usb-'));
  const runtime = path.join(usb, 'runtime', '0.2.0');
  fs.mkdirSync(runtime, { recursive: true });
  if (installJson) fs.writeFileSync(path.join(runtime, 'install.json'), JSON.stringify(installJson));
  return { usb, runtime };
}

test('vesselsRoot: ARK_HOME, then install.json data_root, then the checkout\'s own arks/', () => {
  const { usb, runtime } = portable({ mode: 'portable', version: '0.2.0', data_root: '../../vessels' });
  assert.equal(home.vesselsRoot({ env: {}, root: runtime }), path.join(usb, 'vessels'), 'relative to the runtime directory');
  assert.equal(home.vesselsRoot({ env: { ARK_HOME: path.join(TMP, 'elsewhere') }, root: runtime }), path.join(TMP, 'elsewhere', 'vessels'), 'ARK_HOME wins');
  const bare = portable(null);
  assert.equal(home.vesselsRoot({ env: {}, root: bare.runtime }), path.join(bare.runtime, 'arks'), 'no install.json: the legacy checkout layout');
  assert.equal(home.vesselDir('birds', { env: {}, root: runtime }), path.join(usb, 'vessels', 'birds'));
});

test('vesselsRoot: refuses a data_root inside the runtime directory', () => {
  for (const data_root of ['.', 'vessels', './data/../vessels']) {
    const { runtime } = portable({ mode: 'portable', data_root });
    assert.throws(() => home.vesselsRoot({ env: {}, root: runtime }), /inside the runtime directory/, data_root);
  }
});

test('installMode: portable from install.json, checkout from .git, embedded without its own package.json', () => {
  assert.equal(home.installMode(portable({ mode: 'portable' }).runtime), 'portable');
  const co = portable(null);
  fs.mkdirSync(path.join(co.runtime, '.git'));
  assert.equal(home.installMode(co.runtime), 'checkout');
  assert.equal(home.installMode(portable(null).runtime), 'embedded', 'a copy inside a host app (Seravanna\'s backend/ark)');
  const other = portable(null);
  fs.writeFileSync(path.join(other.runtime, 'package.json'), JSON.stringify({ name: 'ark', version: '9.9.9' }));
  assert.equal(home.installMode(other.runtime), 'unknown');
  assert.equal(home.ownPackage(other.runtime).version, '9.9.9');
  const host = portable(null);
  fs.writeFileSync(path.join(host.runtime, 'package.json'), JSON.stringify({ name: 'seravanna-backend', version: '1.0.0' }));
  assert.equal(home.ownPackage(host.runtime), null, 'a host\'s package.json isn\'t ARK\'s version');
  assert.equal(home.ownPackage(portable(null).runtime), null);
  assert.equal(home.installInfo(portable(null).runtime), null);
  const broken = portable(null);
  fs.writeFileSync(path.join(broken.runtime, 'install.json'), '{not json');
  assert.equal(home.installInfo(broken.runtime), null, 'unreadable install.json is ignored, not fatal');
});

test('a bad install.json data_root fails vessel commands clearly — and ark version still runs', () => {
  // A runtime dir made of links to this one, plus a broken install.json.
  const repo = path.resolve(__dirname, '..');
  const rt = fs.mkdtempSync(path.join(TMP, 'badroot-'));
  // The runtime alone: not a host app's ark.host.js (its requires point into the host).
  for (const e of fs.readdirSync(repo)) if (!['.git', 'arks', 'install.json', 'ark.host.js'].includes(e)) fs.symlinkSync(path.join(repo, e), path.join(rt, e));
  // An embedded copy (Seravanna's backend/ark) has no node_modules of its
  // own — its host's resolve the dependencies; link those in.
  if (!fs.existsSync(path.join(rt, 'node_modules'))) {
    fs.symlinkSync(path.resolve(path.dirname(require.resolve('better-sqlite3/package.json')), '..'), path.join(rt, 'node_modules'));
  }
  fs.writeFileSync(path.join(rt, 'install.json'), JSON.stringify({ mode: 'portable', version: '0.1.0', data_root: '.' }));
  const env = { ...process.env };
  delete env.ARK_HOME;
  const run = (...a) => {
    try { return { code: 0, out: execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(rt, 'cli', 'ark.js'), ...a], { env, cwd: TMP, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (err) { return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') }; }
  };
  const ls = run('ls', 'note');
  assert.equal(ls.code, 1);
  assert.match(ls.err, /^ark: install\.json data_root \(\.\) is inside the runtime directory.*Fix data_root in install\.json\./m);
  assert.doesNotMatch(ls.err, /\n\s+at /, 'a message, not a stack trace');
  const v = run('version');
  assert.equal(v.code, 0, v.err);
  assert.match(v.out, /^ark 0\.1\.0 .*portable install/m);
  assert.match(v.out, /^vessels  \(invalid: install\.json data_root/m);
});

test('the CLI keeps vessels under ARK_HOME, outside the runtime', () => {
  const arkHome = path.join(TMP, 'home');
  execFileSync(process.execPath, [path.resolve(__dirname, '../cli/ark.js'), 'ls', 'note', '--ark', 'outside'], {
    env: { ...process.env, ARK_HOME: arkHome }, stdio: 'pipe',
  });
  assert.ok(fs.existsSync(path.join(arkHome, 'vessels', 'outside', 'ark.sqlite')), 'the vessel was created under ARK_HOME');
  assert.ok(!fs.existsSync(path.resolve(__dirname, '../arks/outside')), 'not inside the runtime');
});

// ── releases: signed manifests, read-only checks ─────────────────────────────

const crypto = require('crypto');
const release = require('../utils/release');

const keypair = () => crypto.generateKeyPairSync('ed25519');
const trusted = (id, pub) => ({ id, public_key: pub.export({ type: 'spki', format: 'der' }).toString('base64') });
const PLATFORM = release.platformKey();
const manifest = (o = {}) => ({
  name: 'ark', version: '0.2.0', channel: 'stable', released_at: '2026-11-24T00:00:00Z', notes: 'Workflows.',
  platforms: { [PLATFORM]: { file: `ark-0.2.0-${PLATFORM}.tar.gz`, sha256: 'a'.repeat(64), size: 1234 } }, ...o,
});
function publish(m, key, id = 'matt-2026', { tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'release-'));
  const bytes = Buffer.from(typeof m === 'string' ? m : JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'release.json'), tamper ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
  fs.writeFileSync(path.join(dir, 'release.json.sig'), JSON.stringify({ key_id: id, signature: crypto.sign(null, bytes, key).toString('base64') }));
  return dir;
}

test('the shipped trust list: every key is a valid Ed25519 public key, ids unique', () => {
  const keys = release.loadTrustedKeys(path.resolve(__dirname, '..'));
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../trust/release-keys.json'), 'utf8'));
  assert.equal(keys.length, raw.length, 'no entry dropped as malformed');
  assert.ok(keys.some(k => k.id === 'matt-2026'), 'the release owner\'s key');
  assert.equal(new Set(keys.map(k => k.id)).size, keys.length);
  for (const k of keys) {
    const pub = crypto.createPublicKey({ key: Buffer.from(k.public_key, 'base64'), format: 'der', type: 'spki' });
    assert.equal(pub.asymmetricKeyType, 'ed25519', k.id);
  }
});

test('compareVersions: numeric parts, a pre-release before its release', () => {
  assert.equal(release.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(release.compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(release.compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(release.compareVersions('1.2.0', '1.1.9-beta'), 1);
  assert.throws(() => release.compareVersions('1.2', '1.2.0'), /not a version/);
  // semver §11's own example ordering.
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(release.compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(release.compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
  }
  assert.equal(release.compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1, 'numeric identifiers compare numerically, not lexically');
});

test('check: never throws — a non-semver current version, bad sources and scheme refusals are statuses', async () => {
  const k = keypair();
  const keys = [trusted('matt-2026', k.publicKey)];
  const dir = publish(manifest(), k.privateKey);
  for (const current of ['0.1', 'dev', '', undefined, null]) {
    const r = await release.check({ source: dir, current, keys });
    assert.equal(r.status, 'unknown_version', String(current));
  }
  assert.equal((await release.check(undefined)).status, 'error', 'even with no arguments');
  assert.equal((await release.check({ source: dir, current: '0.1.0', keys: null })).status, 'error');
  for (const source of ['ftp://example.com/releases/', 'data:text/plain,hi', 'javascript:alert(1)', 'relative/dir']) {
    const r = await release.check({ source, current: '0.1.0', keys });
    assert.equal(r.status, 'unreachable', source);
    assert.match(r.message, /unsupported source|absolute path/);
  }
  const nodeOk = await release.check({ source: dir, current: '0.1.0', keys, nodeVersion: 'weird' });
  assert.equal(nodeOk.status, 'available', 'no min_node: the host\'s Node version isn\'t compared');
  const strictNode = await release.check({ source: publish(manifest({ min_node: '18.0.0' }), k.privateKey), current: '0.1.0', keys, nodeVersion: 'weird' });
  assert.equal(strictNode.status, 'incompatible_node', 'an unreadable host Node version doesn\'t pass a min_node');
});

test('check: file:// sources are decoded (a volume named "My Drive")', async () => {
  const k = keypair();
  const spaced = path.join(TMP, 'My Drive', 'ark releases');
  fs.mkdirSync(spaced, { recursive: true });
  const src = publish(manifest(), k.privateKey);
  for (const f of ['release.json', 'release.json.sig']) fs.copyFileSync(path.join(src, f), path.join(spaced, f));
  const { pathToFileURL } = require('url');
  const url = pathToFileURL(spaced).href;
  assert.match(url, /My%20Drive/);
  assert.equal((await release.check({ source: url, current: '0.1.0', keys: [trusted('matt-2026', k.publicKey)] })).status, 'available');
});

test('runtime.check: the source can\'t come from a dispatch payload (no SSRF / local-read primitive)', async () => {
  const { bootstrap, _reset } = require('../core/bootstrap');
  const { dispatch } = require('../core/dispatch');
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'runtime.sqlite') } });
  const OWNER = { ark_actor_id: 'owner', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
  try {
    for (const source of ['http://169.254.169.254/latest/', '/etc', 'file:///etc/']) {
      await assert.rejects(dispatch({ action: 'runtime.check', payload: { source } }, OWNER), err => err.status === 400 && err.code === 'SOURCE_NOT_ALLOWED', source);
    }
    const ok = await dispatch({ action: 'runtime.check', payload: {} }, OWNER);
    assert.ok(ok.data.status, 'without one, the configured source is used');
    await assert.rejects(dispatch({ action: 'runtime.check', payload: {} }, { ...OWNER, ark_actor_id: 'u', role: 'USER', rank: 10 }), err => err.code === 'CAPABILITY_DENIED', 'owner only');
    // runtime.install: same source rule, owner only, and a checkout refuses.
    await assert.rejects(dispatch({ action: 'runtime.install', payload: { source: '/etc' } }, OWNER), err => err.code === 'SOURCE_NOT_ALLOWED');
    await assert.rejects(dispatch({ action: 'runtime.install', payload: {} }, { ...OWNER, ark_actor_id: 'u', role: 'USER', rank: 10 }), err => err.code === 'CAPABILITY_DENIED');
    await assert.rejects(dispatch({ action: 'runtime.install', payload: {} }, OWNER), err => err.code === 'NOT_PORTABLE' && (home.ownPackage() ? /update it with git/ : /embedded in a host app/).test(err.message));
    await assert.rejects(dispatch({ action: 'runtime.rollback', payload: {} }, { ...OWNER, ark_actor_id: 'u', role: 'USER', rank: 10 }), err => err.code === 'CAPABILITY_DENIED');
    await assert.rejects(dispatch({ action: 'runtime.rollback', payload: {} }, OWNER), err => err.code === 'NOT_PORTABLE');
    const { spaceError } = require('../actions/RuntimeActions')._internals;
    assert.equal(spaceError(500 * 2 ** 20, 70 * 2 ** 20), null);
    assert.match(spaceError(72 * 2 ** 20, 70 * 2 ** 20), /^Not enough space: the update needs 86 MB, the drive has 72 MB free\. Nothing changed\.$/);
  } finally {
    _reset();
  }
});

test('check: every outcome is a status — only a verified manifest is read', async () => {
  const k = keypair();
  const keys = [trusted('matt-2026', k.publicKey)];
  const run = (source, o = {}) => release.check({ source, current: '0.1.0', keys, ...o });

  const ok = await run(publish(manifest(), k.privateKey));
  assert.equal(ok.status, 'available');
  assert.deepEqual({ v: ok.latest.version, key: ok.key_id, file: ok.latest.bundle.file }, { v: '0.2.0', key: 'matt-2026', file: `ark-0.2.0-${PLATFORM}.tar.gz` });

  assert.equal((await run(publish(manifest(), k.privateKey), { current: '0.2.0' })).status, 'up_to_date');
  assert.equal((await run(publish(manifest({ version: '0.1.5' }), k.privateKey), { current: '0.2.0' })).status, 'up_to_date', 'never offers a downgrade');
  assert.equal((await run(publish(manifest({ platforms: { 'plan9-mips': { file: 'x.tgz', sha256: 'b'.repeat(64), size: 1 } } }), k.privateKey))).status, 'unsupported_platform');
  const nodeOld = await run(publish(manifest({ min_node: '99.0.0' }), k.privateKey));
  assert.deepEqual([nodeOld.status, /needs Node 99\.0\.0/.test(nodeOld.message)], ['incompatible_node', true]);
  assert.equal((await run(publish(manifest({ channel: 'beta' }), k.privateKey), { channel: 'stable' })).status, 'other_channel');

  // No replay: after rolling back to 0.1.0, a correctly signed 0.1.5 is still
  // older than the 0.2.0 this install already ran.
  const replay = await run(publish(manifest({ version: '0.1.5' }), k.privateKey), { seen: '0.2.0' });
  assert.deepEqual([replay.status, /older than 0\.2\.0/.test(replay.message)], ['replayed', true]);
  assert.equal((await run(publish(manifest(), k.privateKey), { seen: '0.2.0' })).status, 'available', 'the version already seen may be reinstalled');
  // expires_at: past it, nothing installs; a bad date is malformed.
  const exp = await run(publish(manifest({ expires_at: '2026-01-01T00:00:00Z' }), k.privateKey));
  assert.deepEqual([exp.status, /expired at 2026-01-01/.test(exp.message)], ['expired', true]);
  assert.equal((await run(publish(manifest({ expires_at: '2999-01-01T00:00:00Z' }), k.privateKey))).status, 'available');
  assert.equal((await run(publish(manifest({ expires_at: 'soon' }), k.privateKey))).status, 'invalid_manifest');
  // keepRaw: the exact bytes that verified, for keeping beside the package.
  const kept = await run(publish(manifest(), k.privateKey), { keepRaw: true });
  assert.ok(Buffer.isBuffer(kept.raw.manifest) && Buffer.isBuffer(kept.raw.signature));
  assert.equal(ok.raw, undefined, 'only when asked');

  // Refused before anything in the manifest is used.
  const refused = async (dir, status, o) => {
    const r = await run(dir, o);
    assert.equal(r.status, status, dir);
    assert.equal(r.latest, undefined, 'nothing from an untrusted manifest is reported');
  };
  await refused(publish(manifest(), k.privateKey, 'matt-2026', { tamper: true }), 'unverified');
  await refused(publish(manifest(), keypair().privateKey), 'unverified');                    // a stranger's key, claiming our id
  await refused(publish(manifest(), keypair().privateKey, 'someone-else'), 'unverified');    // an unknown key id
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await refused(publish(manifest(), k.privateKey), 'unverified', { keys: [trusted('matt-2026', rsa.publicKey)] }); // only Ed25519 keys count
  const noSig = publish(manifest(), k.privateKey);
  fs.rmSync(path.join(noSig, 'release.json.sig'));
  await refused(noSig, 'unreachable');
  await refused(publish('{"name":"ark"', k.privateKey), 'invalid_manifest');
  await refused(publish(manifest({ platforms: { [PLATFORM]: { file: '../escape.tgz', sha256: 'a'.repeat(64), size: 1 } } }), k.privateKey), 'invalid_manifest');
  await refused(publish(manifest({ name: 'not-ark' }), k.privateKey), 'invalid_manifest');

  assert.equal((await run(path.join(TMP, 'no-such-dir'))).status, 'unreachable', 'offline / missing media');
  assert.equal((await run('http://127.0.0.1:1/releases/')).status, 'unreachable', 'network down');
  assert.equal((await run(null)).status, 'no_source');
  assert.equal((await run(publish(manifest(), k.privateKey), { keys: [] })).status, 'no_trusted_keys');
});

test('release-sign: keygen keeps the private key out of the repo; sign produces what check verifies', () => {
  const script = path.resolve(__dirname, '../scripts/release-sign.js');
  const node = (...a) => execFileSync(process.execPath, [script, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const keyDir = path.join(TMP, 'keys');
  const out = node('keygen', '--id', 'test-key', '--out', keyDir);
  const entry = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(entry.id, 'test-key');
  assert.equal(fs.statSync(path.join(keyDir, 'test-key.private.pem')).mode & 0o777, 0o600, 'owner-only');
  assert.throws(() => node('keygen', '--id', 'test-key', '--out', keyDir), /already exists/);
  assert.throws(() => node('keygen', '--id', 'x', '--out', path.resolve(__dirname, '..', 'trust')), /inside the ARK repository/);

  const dir = fs.mkdtempSync(path.join(TMP, 'to-sign-'));
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(manifest()));
  node('sign', dir, '--key', path.join(keyDir, 'test-key.private.pem'), '--id', 'test-key');
  assert.equal(release.verifySignature(fs.readFileSync(path.join(dir, 'release.json')), fs.readFileSync(path.join(dir, 'release.json.sig')), [entry]), 'test-key');
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(manifest({ name: 'nope' })));
  assert.throws(() => node('sign', dir, '--key', path.join(keyDir, 'test-key.private.pem'), '--id', 'test-key'), /name must be "ark"/, 'won\'t sign a malformed manifest');
});

test('CLI: version, update --check, and update / --rollback say what this version can do', () => {
  const cli = path.resolve(__dirname, '../cli/ark.js');
  const env = { ...process.env, ARK_HOME: path.join(TMP, 'cli-home') };
  const cwd = fs.mkdtempSync(path.join(TMP, 'cwd-'));
  const runCli = (...a) => {
    try { return { code: 0, out: execFileSync(process.execPath, [cli, ...a], { env, cwd, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (err) { return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') }; }
  };
  const v = runCli('version');
  assert.equal(v.code, 0);
  // A checkout reads its version from package.json; an embedded copy (no
  // package.json of its own) says unknown rather than failing.
  const own = home.ownPackage();
  assert.match(v.out, own ? new RegExp(`^ark ${own.version.replace(/\./g, '\\.')}`, 'm') : /^ark unknown .*embedded install/m);
  assert.match(v.out, new RegExp(`vessels  ${path.join(TMP, 'cli-home', 'vessels').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // A manifest signed by a key the shipped trust list doesn't hold.
  const k = keypair();
  const c = runCli('update', '--check', '--source', publish(manifest(), k.privateKey));
  assert.equal(c.code, 0);
  // A checkout refuses it (unverified); an embedded copy has no version of
  // its own to compare and says it updates with its host.
  assert.match(c.out, own ? /unverified: The release manifest is not signed by a trusted key/ : /unknown version[\s\S]*embedded in a host app/);

  const rb = runCli('update', '--rollback');
  assert.equal(rb.code, 2);
  assert.match(rb.err, /--rollback switches this install back to its previous version and asks first/);
  const rbCo = runCli('update', '--rollback', '--yes');
  assert.equal(rbCo.code, 1);
  assert.match(rbCo.err, own ? /NOT_PORTABLE[\s\S]*update it with git/ : /NOT_PORTABLE[\s\S]*embedded in a host app/);
  // Installing without a terminal needs --yes — refused before anything is read.
  const noYes = runCli('update');
  assert.equal(noYes.code, 2);
  assert.match(noYes.err, /asks first — run it in a terminal, or pass --yes/);
  // A checkout (or embedded copy) never installs a bundle.
  const co = runCli('update', '--yes', '--source', publish(manifest(), k.privateKey));
  assert.equal(co.code, 1);

  // On a fresh install none of that wrote anything: no vessel, no files.
  assert.ok(!fs.existsSync(env.ARK_HOME), 'no vessel created just to read the runtime');
  assert.deepEqual(fs.readdirSync(cwd), [], 'nothing written to the working directory');

  // With a vessel, the call is recorded in its ledger like any other.
  runCli('ls', 'note');
  assert.equal(runCli('version').code, 0);
  assert.match(runCli('ledger').out, /runtime\.version/);
});

// ── ready mode: ark setup / ark start ───────────────────────────────────────

const cliIn = home => (...a) => {
  try { return { code: 0, out: execFileSync(process.execPath, [path.resolve(__dirname, '../cli/ark.js'), ...a], { env: { ...process.env, ARK_HOME: home }, cwd: TMP, encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (err) { return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') }; }
};

test('ark setup: asks in a terminal; --yes sets up a vessel with project dashboards; re-running reviews it', () => {
  const home = path.join(TMP, 'setup-home');
  const ark = cliIn(home);
  const noTty = ark('setup');
  assert.equal(noTty.code, 2);
  assert.match(noTty.err, /run it in a terminal, or pass --yes/);
  assert.ok(!fs.existsSync(home), 'nothing created without answers');

  const first = ark('setup', '--name', 'Alice', '--yes');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Welcome to ARK\.[\s\S]*Created your vessel for Alice\.[\s\S]*Added project dashboards\.[\s\S]*Setup is done/);
  assert.doesNotMatch(first.out + (first.err || ''), /LLM adapter|Architecture Charter/, 'no startup chatter');
  assert.ok(fs.existsSync(path.join(home, 'vessels', 'default', 'ark.sqlite')));
  const templates = JSON.parse(ark('dispatch', 'template.list').out).data.templates.map(t => t.slug);
  assert.ok(templates.includes('project-base') && templates.includes('project-developer'));

  const again = ark('setup', '--yes');
  assert.match(again.out, /^ARK setup$[\s\S]*Owner\s+Alice/m);
  assert.doesNotMatch(again.out, /Added project dashboards/, 'idempotent');
  assert.match(ark('setup', '--name', 'Alicia', '--yes').out, /Owner\s+Alicia/, 'renamed');
  assert.match(ark('setup', '--yes').out, /Owner\s+Alicia/);

  const bare = ark();
  assert.equal(bare.code, 1, 'plain ark piped/scripted still prints usage');
  assert.match(bare.err, /ark  \(or: ark start\)/);
});

test('ark setup: --persona is taken exactly as given; unset means the default persona, not "whichever is first"', () => {
  // A runtime whose personas.yaml lists store FIRST — so "fall back to the
  // first persona" would give the wrong answer.
  const repo = path.resolve(__dirname, '..');
  const rt = fs.mkdtempSync(path.join(TMP, 'personas-'));
  for (const e of fs.readdirSync(repo)) if (!['.git', 'arks', 'install.json', 'ark.host.js', 'pipelines'].includes(e)) fs.symlinkSync(path.join(repo, e), path.join(rt, e));
  if (!fs.existsSync(path.join(rt, 'node_modules'))) fs.symlinkSync(path.resolve(path.dirname(require.resolve('better-sqlite3/package.json')), '..'), path.join(rt, 'node_modules'));
  fs.mkdirSync(path.join(rt, 'pipelines'));
  for (const e of fs.readdirSync(path.join(repo, 'pipelines'))) if (e !== 'personas.yaml') fs.symlinkSync(path.join(repo, 'pipelines', e), path.join(rt, 'pipelines', e));
  fs.writeFileSync(path.join(rt, 'pipelines', 'personas.yaml'), 'personas:\n  store: []\n  hiker:\n    - usb-sd-birds\n    - classify\n');
  const arkAt = home => (...a) => {
    try { return { code: 0, out: execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(rt, 'cli', 'ark.js'), ...a], { env: { ...process.env, ARK_HOME: home }, cwd: TMP, encoding: 'utf8', stdio: 'pipe' }) }; }
    catch (err) { return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') }; }
  };
  const vesselTypes = home => {
    const out = arkAt(home)('dispatch', 'artifact.list', '--payload', JSON.stringify({ limit: 200 })).out;
    return JSON.parse(out).data.artifacts.map(a => a.artifact_type).filter(t => ['hiker', 'store'].includes(t));
  };
  for (const [persona, home] of [['hiker', 'persona-hiker'], ['store', 'persona-store'], [undefined, 'persona-default']]) {
    const h = path.join(TMP, home);
    const r = arkAt(h)('setup', '--name', 'P', '--yes', ...(persona ? ['--persona', persona] : []));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(vesselTypes(h), [persona || 'hiker'], `--persona ${persona ?? '(none)'} with store listed first`);
  }
  const bad = arkAt(path.join(TMP, 'persona-bad'))('setup', '--name', 'P', '--yes', '--persona', 'pirate');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown persona "pirate"/);
  assert.ok(!fs.existsSync(path.join(TMP, 'persona-bad', 'vessels', 'default', 'ark.sqlite')), 'nothing created for an unknown persona');
});

test('ark start: sets up on first use, then serves Mission Control in ready mode', async () => {
  const { spawn } = require('child_process');
  const home = path.join(TMP, 'start-home');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../cli/ark.js'), 'start', '--yes', '--name', 'Carol', '--no-open', '--port', '0'],
    { env: { ...process.env, ARK_HOME: home }, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  try {
    const url = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no URL in time:\n${out}`)), 30000);
      child.stdout.on('data', () => {
        // Wait for the last line, not just the URL — output arrives in chunks.
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]+)/.exec(out);
        if (m && /Keep this window open/.test(out)) { clearTimeout(t); resolve({ base: m[1], token: m[2] }); }
      });
      child.on('exit', code => reject(new Error(`exited ${code}:\n${out}`)));
    });
    assert.match(out, /Created your vessel for Carol\.[\s\S]*ARK is ready, Carol\. Mission Control is open in your browser:[\s\S]*Keep this window open/);
    const health = await fetch(`${url.base}/api/health`, { headers: { authorization: `Bearer ${url.token}` } });
    assert.equal(health.status, 200, 'Mission Control is really up');
  } finally {
    child.kill('SIGINT');
    await new Promise(r => child.on('exit', r));
  }
  assert.ok(fs.existsSync(path.join(home, 'vessels', 'default', 'ark.sqlite')));
});

test('data format: vessels record it; a vessel from a newer ARK is refused, untouched', () => {
  const Database = require('better-sqlite3');
  const { DATA_FORMAT } = require('../utils/dataFormat');
  const h = path.join(TMP, 'format-home');
  const ark = cliIn(h);
  assert.equal(ark('ls', 'note').code, 0);
  const file = path.join(h, 'vessels', 'default', 'ark.sqlite');
  const fmt = () => { const db = new Database(file, { readonly: true }); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };
  assert.equal(fmt(), DATA_FORMAT, 'a new vessel records the format');

  // A vessel from before the guard (format 0) is brought to the baseline.
  let db = new Database(file); db.pragma('user_version = 0'); db.close();
  assert.equal(ark('ls', 'note').code, 0);
  assert.equal(fmt(), DATA_FORMAT);

  // Newer than this ARK reads: refused before anything touches it.
  db = new Database(file); db.pragma(`user_version = ${DATA_FORMAT + 1}`); db.close();
  const before = fs.readFileSync(file);
  const r = ark('ls', 'note');
  assert.notEqual(r.code, 0);
  assert.match(r.err, new RegExp(`written by a newer ARK \\(data format ${DATA_FORMAT + 1}\\); this ARK reads up to ${DATA_FORMAT}`));
  assert.deepEqual(fs.readFileSync(file), before, 'the vessel is unchanged');
  assert.equal(fmt(), DATA_FORMAT + 1);
});
