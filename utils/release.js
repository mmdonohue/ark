'use strict';

// Releases: what an update installs, and how this runtime decides to trust
// it. Read-only here — nothing is downloaded beyond the manifest, nothing
// is executed.
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

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FETCH_TIMEOUT_MS = 10000;
const MAX_MANIFEST_BYTES = 256 * 1024;

const platformKey = (p = process.platform, a = process.arch) => `${p}-${a}`;

// -1 / 0 / 1. A pre-release sorts before its release (1.2.0-beta < 1.2.0).
function compareVersions(a, b) {
  const x = SEMVER.exec(a); const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] < +y[i] ? -1 : 1;
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return x[4] < y[4] ? -1 : 1;
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
  if (m.min_node != null && !SEMVER.test(m.min_node)) return 'min_node must be x.y.z';
  if (!m.platforms || typeof m.platforms !== 'object' || !Object.keys(m.platforms).length) return 'platforms must list at least one bundle';
  for (const [k, b] of Object.entries(m.platforms)) {
    if (!PLATFORM.test(k)) return `platform "${k}" must look like darwin-arm64`;
    if (!b || typeof b.file !== 'string' || !b.file || b.file.includes('/') || b.file.includes('\\') || b.file.startsWith('.')) return `platforms.${k}.file must be a plain file name`;
    if (!SHA256.test(b.sha256 || '')) return `platforms.${k}.sha256 must be a sha256 hex digest`;
    if (!Number.isInteger(b.size) || b.size <= 0) return `platforms.${k}.size must be a positive integer`;
  }
  return null;
}

// Reads release.json + release.json.sig from a URL or a folder (or file://).
async function readSource(source) {
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
  const dir = source.startsWith('file://') ? new URL(source).pathname : source;
  const read = name => {
    const p = path.join(dir, name);
    if (fs.statSync(p).size > MAX_MANIFEST_BYTES) throw Object.assign(new Error(`${name} is too large`), { code: 'SOURCE_TOO_LARGE' });
    return fs.readFileSync(p);
  };
  return { manifest: read('release.json'), signature: read('release.json.sig') };
}

// The whole read-only check. Every outcome is a status, never a throw.
//   no_source | no_trusted_keys | unreachable | unverified | invalid_manifest
//   | other_channel | up_to_date | unsupported_platform | incompatible_node | available
async function check({ source, current, channel = null, keys, platform = platformKey(), nodeVersion = process.versions.node }) {
  const base = { current, platform, source: source || null };
  if (!source) return { ...base, status: 'no_source', message: 'No update source is configured (install.json update_source, ARK_UPDATE_SOURCE, or --source).' };
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
  const bundle = m.platforms[platform];
  if (!bundle) return { ...base, status: 'unsupported_platform', key_id, latest, message: `${m.version} has no bundle for ${platform}.` };
  if (m.min_node && compareVersions(nodeVersion.split('-')[0], m.min_node) < 0) {
    return { ...base, status: 'incompatible_node', key_id, latest, message: `${m.version} needs Node ${m.min_node}; this host has ${nodeVersion}.` };
  }
  return { ...base, status: 'available', key_id, latest: { ...latest, bundle: { file: bundle.file, size: bundle.size, sha256: bundle.sha256 } } };
}

module.exports = { check, verifySignature, manifestError, compareVersions, loadTrustedKeys, readSource, platformKey };
