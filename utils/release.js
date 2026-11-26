'use strict';

// Releases: what an update installs, and how this runtime decides to trust
// it. check() reads only the manifest; fetchBundle() copies a bundle the
// signed manifest describes, verified as it streams. Nothing is executed.
//
// A release source (a URL or a local/USB folder) holds:
//   release.json      { name: 'ark', version, channel, released_at,
//                       min_node?, notes?,
//                       platforms: { '<platform>-<arch>': { file, sha256, size } } }
//   release.json.sig  { key_id, signature }   — Ed25519 over release.json's exact bytes
//
// The runtime trusts only the public keys it ships (trust/release-keys.json:
// [{ id, public_key }], public_key as base64 SPKI DER or PEM). A manifest
// that doesn't verify against one of them is never read further: its
// version isn't even reported. Bundles are per platform (better-sqlite3 is
// native) and carry their own node_modules; Node itself is the host's.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FETCH_TIMEOUT_MS = 10000;
const MAX_MANIFEST_BYTES = 256 * 1024;

const platformKey = (p = process.platform, a = process.arch) => `${p}-${a}`;

const isVersion = v => typeof v === 'string' && SEMVER.test(v);

// -1 / 0 / 1, by semver precedence (§11): numeric parts numerically; a
// pre-release before its release; pre-release identifiers dot by dot —
// numeric ones numerically and before alphanumeric ones, which compare in
// ASCII order; a shorter identifier list first when all else is equal.
// Throws on a non-version — callers that must not throw check first.
function compareVersions(a, b) {
  const x = SEMVER.exec(a); const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] < +y[i] ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const p = x[4].split('.'); const q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const pn = /^\d+$/.test(p[i]); const qn = /^\d+$/.test(q[i]);
    if (pn && qn) { if (+p[i] !== +q[i]) return +p[i] < +q[i] ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

function _publicKey(k) {
  const s = String(k.public_key || '').trim();
  return s.startsWith('-----BEGIN')
    ? crypto.createPublicKey(s)
    : crypto.createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
}

function loadTrustedKeys(root) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, 'trust', 'release-keys.json'), 'utf8'));
    return Array.isArray(list) ? list.filter(k => k && k.id && k.public_key) : [];
  } catch { return []; }
}

// → key id that verified, or null. Only Ed25519 keys count.
function verifySignature(manifestBytes, sigBytes, keys) {
  let sig;
  try { sig = JSON.parse(Buffer.from(sigBytes).toString('utf8')); } catch { return null; }
  if (!sig?.key_id || typeof sig.signature !== 'string') return null;
  const key = keys.find(k => k.id === sig.key_id);
  if (!key) return null;
  try {
    const pub = _publicKey(key);
    if (pub.asymmetricKeyType !== 'ed25519') return null;
    return crypto.verify(null, Buffer.from(manifestBytes), pub, Buffer.from(sig.signature, 'base64')) ? key.id : null;
  } catch { return null; }
}

// → error message, or null.
function manifestError(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'not an object';
  if (m.name !== 'ark') return 'name must be "ark"';
  if (!SEMVER.test(m.version || '')) return 'version must be x.y.z';
  if (typeof m.channel !== 'string' || !/^[a-z][a-z0-9-]{0,19}$/.test(m.channel)) return 'channel must be a short name';
  if (!m.released_at || Number.isNaN(Date.parse(m.released_at))) return 'released_at must be a date';
  if (m.expires_at != null && Number.isNaN(Date.parse(m.expires_at))) return 'expires_at must be a date';
  if (m.min_node != null && !SEMVER.test(m.min_node)) return 'min_node must be x.y.z';
  if (!m.platforms || typeof m.platforms !== 'object' || !Object.keys(m.platforms).length) return 'platforms must list at least one bundle';
  for (const [k, b] of Object.entries(m.platforms)) {
    if (!PLATFORM.test(k)) return `platform "${k}" must look like darwin-arm64`;
    if (!b || typeof b.file !== 'string' || !b.file || b.file.includes('/') || b.file.includes('\\') || b.file.startsWith('.')) return `platforms.${k}.file must be a plain file name`;
    if (!SHA256.test(b.sha256 || '')) return `platforms.${k}.sha256 must be a sha256 hex digest`;
    if (!Number.isInteger(b.size) || b.size <= 0) return `platforms.${k}.size must be a positive integer`;
    // A bundle that carries its own Node says which (its native modules are
    // built for exactly that ABI).
    if (b.node != null && !SEMVER.test(b.node)) return `platforms.${k}.node must be x.y.z`;
    if (b.node_abi != null && !/^\d{1,4}$/.test(String(b.node_abi))) return `platforms.${k}.node_abi must be a number`;
    if ((b.node == null) !== (b.node_abi == null)) return `platforms.${k}: node and node_abi go together`;
  }
  return null;
}

// The official Node.js download for a platform, as nodejs.org names it.
//   darwin-arm64 → node-v24.22.3-darwin-arm64.tar.gz
//   win32-x64    → node-v24.22.3-win-x64.zip
function nodeDist(version, platform = platformKey()) {
  const [os, arch] = platform.split('-');
  const dist = `${os === 'win32' ? 'win' : os}-${arch}`;
  const name = `node-v${version}-${dist}`;
  return { name, file: `${name}.${os === 'win32' ? 'zip' : 'tar.gz'}`, binary: os === 'win32' ? 'node.exe' : 'bin/node' };
}

// Reads release.json + release.json.sig from an http(s) URL, a file:// URL,
// or an absolute folder path. Anything else is refused. The source comes
// only from owner configuration or the local CLI (never a dispatch payload).
async function readSource(source) {
  if (typeof source !== 'string' || !source) throw Object.assign(new Error('no source'), { code: 'SOURCE_SCHEME' });
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^(https?|file):/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) {
    throw Object.assign(new Error(`unsupported source "${source.split(':')[0]}:" — use https://, http://, file:// or a folder path`), { code: 'SOURCE_SCHEME' });
  }
  if (/^https?:\/\//i.test(source)) {
    const base = source.endsWith('/') ? source : `${source}/`;
    const get = async name => {
      const res = await fetch(new URL(name, base), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw Object.assign(new Error(`${name}: HTTP ${res.status}`), { code: 'SOURCE_HTTP' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_MANIFEST_BYTES) throw Object.assign(new Error(`${name} is too large`), { code: 'SOURCE_TOO_LARGE' });
      return buf;
    };
    return { manifest: await get('release.json'), signature: await get('release.json.sig') };
  }
  // fileURLToPath decodes %20 and the like (a USB volume named "My Drive").
  const dir = /^file:/i.test(source) ? fileURLToPath(source) : source;
  if (!path.isAbsolute(dir)) throw Object.assign(new Error('a folder source must be an absolute path'), { code: 'SOURCE_SCHEME' });
  const read = name => {
    const p = path.join(dir, name);
    if (fs.statSync(p).size > MAX_MANIFEST_BYTES) throw Object.assign(new Error(`${name} is too large`), { code: 'SOURCE_TOO_LARGE' });
    return fs.readFileSync(p);
  };
  return { manifest: read('release.json'), signature: read('release.json.sig') };
}

// The whole read-only check. Every outcome is a status, never a throw.
//   no_source | unknown_version | no_trusted_keys | unreachable | unverified
//   | invalid_manifest | other_channel | up_to_date | unsupported_platform
//   | expired | replayed | incompatible_node | available | error (anything unforeseen)
//
// seen: the highest version this install has ever activated — a correctly
// signed release older than that is a replay, never "available". keepRaw:
// also return the exact manifest and signature bytes that verified (for
// installing: kept beside the package as its proof).
async function check(args) {
  try {
    return await _check(args);
  } catch (err) {
    return { current: args?.current ?? null, platform: args?.platform || platformKey(), source: args?.source || null,
      status: 'error', message: `The check failed: ${err.message}` };
  }
}

async function _check({ source, current, channel = null, keys, platform = platformKey(), nodeVersion = process.versions.node, seen = null, now = Date.now(), keepRaw = false }) {
  const base = { current, platform, source: source || null };
  if (!source) return { ...base, status: 'no_source', message: 'No update source is configured (install.json update_source, ARK_UPDATE_SOURCE, or --source).' };
  if (!isVersion(current)) return { ...base, status: 'unknown_version', message: `This runtime's version "${current}" isn't x.y.z, so nothing can be compared with it.` };
  if (!keys.length) return { ...base, status: 'no_trusted_keys', message: 'This runtime trusts no release keys, so no release can be verified.' };

  let raw;
  try { raw = await readSource(source); }
  catch (err) { return { ...base, status: 'unreachable', message: `Couldn't read the update source: ${err.code === 'ENOENT' ? 'release.json or its signature is missing' : err.message}` }; }

  const key_id = verifySignature(raw.manifest, raw.signature, keys);
  if (!key_id) return { ...base, status: 'unverified', message: 'The release manifest is not signed by a trusted key. Nothing in it was used.' };

  let m;
  try { m = JSON.parse(raw.manifest.toString('utf8')); } catch { m = null; }
  const bad = manifestError(m);
  if (bad) return { ...base, status: 'invalid_manifest', key_id, message: `Signed, but malformed: ${bad}` };

  const latest = { version: m.version, channel: m.channel, released_at: m.released_at, ...(m.notes ? { notes: String(m.notes).slice(0, 2000) } : {}) };
  if (channel && m.channel !== channel) return { ...base, status: 'other_channel', key_id, latest, message: `The source publishes ${m.channel}; this install follows ${channel}.` };
  if (compareVersions(m.version, current) <= 0) return { ...base, status: 'up_to_date', key_id, latest };
  // A valid signature doesn't make a release current: an old signed one,
  // served again, must not walk the install back.
  if (isVersion(seen) && compareVersions(m.version, seen) < 0) {
    return { ...base, status: 'replayed', key_id, latest, message: `${m.version} is older than ${seen}, which this install has already run. A signed release can't be replayed to downgrade it.` };
  }
  if (m.expires_at && Date.parse(m.expires_at) <= now) {
    return { ...base, status: 'expired', key_id, latest, message: `This release manifest expired at ${m.expires_at}. Nothing installs from it.` };
  }
  const bundle = m.platforms[platform];
  if (!bundle) return { ...base, status: 'unsupported_platform', key_id, latest, message: `${m.version} has no bundle for ${platform}.` };
  // A bundle with its own Node doesn't depend on the host's; otherwise the
  // host's Node must meet min_node.
  const hostNode = String(nodeVersion).split('-')[0];
  if (!bundle.node && m.min_node && (!isVersion(hostNode) || compareVersions(hostNode, m.min_node) < 0)) {
    return { ...base, status: 'incompatible_node', key_id, latest, message: `${m.version} needs Node ${m.min_node}; this host has ${nodeVersion}.` };
  }
  return { ...base, status: 'available', key_id, latest: { ...latest, bundle: { file: bundle.file, size: bundle.size, sha256: bundle.sha256, ...(bundle.node ? { node: bundle.node } : {}) } },
    ...(keepRaw ? { raw } : {}) };
}

// Copies a release's bundle from its source to dest, verifying it against
// the signed manifest's size and sha256 as it streams. It lands as
// <dest>.part first — always started afresh, so an interrupted copy is never
// half-trusted — and is renamed to dest only once it matches, after an
// fsync (a USB stick pulled right after still holds the whole file).
const BUNDLE_TIMEOUT_MS = 30 * 60 * 1000;
async function fetchBundle({ source, file, size, sha256, dest }) {
  if (!file || file.includes('/') || file.includes('\\') || file.startsWith('.')) throw Object.assign(new Error('bad bundle name'), { code: 'BUNDLE_NAME' });
  const part = `${dest}.part`;
  fs.rmSync(part, { force: true });
  let chunks;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(new URL(file, source.endsWith('/') ? source : `${source}/`), { signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw Object.assign(new Error(`${file}: HTTP ${res.status}`), { code: 'SOURCE_HTTP' });
    chunks = res.body;
  } else {
    const dir = /^file:/i.test(source) ? fileURLToPath(source) : source;
    if (!path.isAbsolute(dir)) throw Object.assign(new Error('a folder source must be an absolute path'), { code: 'SOURCE_SCHEME' });
    chunks = fs.createReadStream(path.join(dir, file));
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const fd = fs.openSync(part, 'w');
  try {
    for await (const chunk of chunks) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > size) throw Object.assign(new Error(`${file} is larger than the ${size} bytes the signed manifest says`), { code: 'BUNDLE_MISMATCH' });
      hash.update(buf);
      fs.writeSync(fd, buf);
    }
    if (bytes !== size) throw Object.assign(new Error(`${file} stopped at ${bytes} of ${size} bytes — the copy was interrupted or the file is incomplete`), { code: 'BUNDLE_MISMATCH' });
    if (hash.digest('hex') !== sha256) throw Object.assign(new Error(`${file} doesn't match the signed manifest's sha256`), { code: 'BUNDLE_MISMATCH' });
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(part, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(part, dest);
}

// The publisher's side: the release.json.sig content for these exact bytes.
// Refuses a malformed manifest or a non-Ed25519 key.
function signManifest(manifestBytes, privateKeyPem, keyId) {
  let m;
  try { m = JSON.parse(Buffer.from(manifestBytes).toString('utf8')); } catch { throw new Error('release.json is not JSON'); }
  const bad = manifestError(m);
  if (bad) throw new Error(`release.json: ${bad}`);
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The key must be Ed25519.');
  return JSON.stringify({ key_id: keyId, signature: crypto.sign(null, Buffer.from(manifestBytes), key).toString('base64') });
}

module.exports = { check, fetchBundle, verifySignature, manifestError, signManifest, compareVersions, isVersion, loadTrustedKeys, readSource, platformKey, nodeDist };
