'use strict';

// RuntimeActions — the ARK runtime itself (not artifacts: ark.update is the
// artifact action). All owner-only.
//
//   runtime.version  what is installed: version, build, channel, install
//                    mode, where vessels live, host platform and Node
//   runtime.check    whether a newer verified release exists (read-only:
//                    fetches the signed manifest, never a bundle)
//   runtime.install  installs it into a packed portable install: the bundle
//                    copied into packages/ and verified, then current.json
//                    switched — health-checked, and switched back if the new
//                    version doesn't start

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { RUNTIME_ROOT, installInfo, installMode, vesselsRoot, ownPackage } = require('../utils/arkHome');
const release = require('../utils/release');

function _version(root = RUNTIME_ROOT) {
  const info = installInfo(root) || {};
  const pkg = ownPackage(root);
  let build = info.build || null;
  if (!build && fs.existsSync(path.join(root, '.git'))) {
    try { build = execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a usable checkout */ }
  }
  return {
    version: info.version || pkg?.version || 'unknown',
    build,
    channel: info.channel || (installMode(root) === 'checkout' ? 'dev' : null),
    install: installMode(root),
    // Where the install lives (packages/, runtime/current.json, vessels/) —
    // set by the launcher; for a packed install the runtime itself may be
    // unpacked on this computer instead (runtime_dir).
    install_root: installMode(root) === 'portable' ? (process.env.ARK_INSTALL_ROOT || path.resolve(root, '..', '..')) : null,
    runtime_dir: root,
    vessels_dir: (() => { try { return vesselsRoot({ root }); } catch (err) { return `(invalid: ${err.message})`; } })(),
    platform: release.platformKey(),
    node: process.versions.node,
    // Running on the Node this runtime ships with (runtime/<v>/node/)?
    node_bundled: (() => { try { return fs.realpathSync(process.execPath).startsWith(fs.realpathSync(path.join(root, 'node')) + path.sep); } catch { return false; } })(),
    update_source: info.update_source || process.env.ARK_UPDATE_SOURCE || null,
  };
}

async function version(ctx, payload, packet) {
  const v = _version();
  packet.log.push(`runtime.version → ${v.version} (${v.install})`);
  return { data: v };
}

// The update source comes only from the owner: install.json update_source,
// ARK_UPDATE_SOURCE, or — for this process alone — the local CLI's
// --source (useSource). Never from a payload: any dispatch surface could
// otherwise point the runtime at an arbitrary URL or local path.
let cliSource = null;
function useSource(source) { cliSource = source || null; }

// payload: {} — a `source` in the payload is refused.
async function check(ctx, payload, packet) {
  if (payload.source !== undefined) {
    throw Object.assign(new Error('runtime.check takes no source — set install.json update_source or ARK_UPDATE_SOURCE, or use the CLI\'s --source'), { status: 400, code: 'SOURCE_NOT_ALLOWED' });
  }
  const v = _version();
  const source = cliSource || v.update_source;
  const result = await release.check({ source, current: v.version, channel: v.channel === 'dev' ? null : v.channel, keys: release.loadTrustedKeys(RUNTIME_ROOT), seen: v.install_root ? _seen(v.install_root) : null });
  // A checkout updates with git; say so rather than offer a bundle.
  const note = {
    checkout: 'This is a developer checkout: update it with git, not with a release bundle.',
    embedded: 'This ARK is embedded in a host app: it updates with the host, not with a release bundle.',
  }[v.install] || null;
  packet.log.push(`runtime.check → ${result.status}${result.latest ? ` (${result.latest.version})` : ''}`);
  return { data: { ...result, install: v.install, ...(note ? { note } : {}) } };
}

// ── Installing ──────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // a health check can unpack onto a slow stick
const SPACE_MARGIN = 16 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const _readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The highest version this install has ever activated (runtime/seen.json).
function _seen(root) {
  const s = _readJson(path.join(root, 'runtime', 'seen.json'));
  return release.isVersion(s?.highest) ? s.highest : null;
}

// write-then-rename: a pulled drive leaves the old file or the new one.
function _writeAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// → error message, or null: room for the bundle plus a margin.
function spaceError(freeBytes, size) {
  if (freeBytes >= size + SPACE_MARGIN) return null;
  const mb = n => `${Math.ceil(n / 1024 / 1024)} MB`;
  return `Not enough space: the update needs ${mb(size + SPACE_MARGIN)}, the drive has ${mb(freeBytes)} free. Nothing changed.`;
}

function _writable(dir) {
  const probe = path.join(dir, `.ark-write-test-${process.pid}`);
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(probe, ''); fs.rmSync(probe, { force: true }); }
  catch (err) {
    const why = { EROFS: 'the drive is read-only', EACCES: 'permission denied', EPERM: 'permission denied' }[err.code] || err.message;
    throw _fail(409, 'NOT_WRITABLE', `Can't write to ${dir}: ${why}. Nothing changed.`);
  }
}

// One update at a time per install.
function _lock(root) {
  const file = path.join(root, 'runtime', 'update.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let age = 0;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone meanwhile */ }
    if (age < LOCK_STALE_MS) throw _fail(409, 'UPDATE_IN_PROGRESS', `Another update is running on this install (${file}).`);
    fs.writeFileSync(file, String(process.pid));
  }
  return () => fs.rmSync(file, { force: true });
}

// The new version, through the install's own launcher, exactly as the next
// start will run it (it unpacks there first). → null, or why it failed.
function _health(root, version) {
  const r = spawnSync('sh', [path.join(root, 'ark'), 'version'], { encoding: 'utf8', timeout: HEALTH_TIMEOUT_MS, env: process.env });
  if (r.status === 0 && new RegExp(`^ark ${version.replace(/\./g, '\\.')} `, 'm').test(r.stdout || '')) return null;
  const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-4).join('\n');
  return r.error ? r.error.message : `exit ${r.status}${tail ? `: ${tail}` : ''}`;
}

// payload: {} — like runtime.check, the source is the owner's configuration
// or the CLI's --source, never a payload. The CLI asks for confirmation (or
// --yes) before dispatching this; nothing here runs on its own.
async function install(ctx, payload, packet) {
  if (payload.source !== undefined) {
    throw _fail(400, 'SOURCE_NOT_ALLOWED', 'runtime.install takes no source — set install.json update_source or ARK_UPDATE_SOURCE, or use the CLI\'s --source');
  }
  const v = _version();
  if (v.install !== 'portable') {
    throw _fail(409, 'NOT_PORTABLE', {
      checkout: 'This is a developer checkout: update it with git, not with a release bundle.',
      embedded: 'This ARK is embedded in a host app: it updates with the host, not with a release bundle.',
    }[v.install] || `Only a portable install can update itself (this one is "${v.install}").`);
  }
  if (process.platform === 'win32') throw _fail(409, 'UNSUPPORTED', 'Updating a Windows install isn\'t supported yet.');
  const root = v.install_root;
  const currentFile = path.join(root, 'runtime', 'current.json');
  const currentText = (() => { try { return fs.readFileSync(currentFile, 'utf8'); } catch { return null; } })();
  const current = currentText && _readJson(currentFile);
  if (!current?.version) throw _fail(409, 'NO_INSTALL', `${currentFile} is missing or unreadable.`);
  if (current.version !== v.version) {
    throw _fail(409, 'STALE_RUNTIME', `This install was switched to ${current.version} while ${v.version} was running. Restart ARK, then update.`);
  }

  _writable(path.join(root, 'packages'));
  const unlock = _lock(root);
  try {
    const source = cliSource || v.update_source;
    const seen = _seen(root);
    const c = await release.check({ source, current: v.version, channel: v.channel === 'dev' ? null : v.channel, keys: release.loadTrustedKeys(RUNTIME_ROOT), seen, keepRaw: true });
    const { raw, ...checked } = c;
    if (c.status !== 'available') {
      packet.log.push(`runtime.install → not installed (${c.status})`);
      return { data: { ...checked, installed: false } };
    }
    const b = c.latest.bundle;
    const packages = path.join(root, 'packages');
    const dest = path.join(packages, b.file);

    // Already here and intact (an earlier attempt that stopped after copying)?
    const have = fs.existsSync(dest) && fs.statSync(dest).size === b.size
      && require('crypto').createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === b.sha256;
    if (!have) {
      const st = fs.statfsSync(packages);
      const space = spaceError(st.bavail * st.bsize, b.size);
      if (space) throw _fail(409, 'NO_SPACE', space);
      try { await release.fetchBundle({ source, file: b.file, size: b.size, sha256: b.sha256, dest }); }
      catch (err) {
        if (err.code === 'BUNDLE_MISMATCH') throw _fail(422, 'BUNDLE_MISMATCH', `${err.message}. Nothing changed.`);
        throw _fail(502, 'FETCH_FAILED', `Couldn't copy ${b.file}: ${err.message}. Nothing changed.`);
      }
    }
    fs.writeFileSync(`${dest}.release.json`, raw.manifest);
    fs.writeFileSync(`${dest}.release.json.sig`, raw.signature);

    const previous = { version: current.version, ...(current.package ? { package: current.package, sha256: current.sha256 } : {}) };
    _writeAtomic(currentFile, JSON.stringify({ version: c.latest.version, package: b.file, sha256: b.sha256, activated_at: new Date().toISOString(), previous }, null, 2));
    packet.log.push(`runtime.install → ${v.version} → ${c.latest.version}: switched, health-checking`);

    const unhealthy = _health(root, c.latest.version);
    if (unhealthy) {
      _writeAtomic(currentFile, currentText);
      packet.log.push(`runtime.install → health check failed, back on ${v.version}`);
      return { data: { ...checked, status: 'rolled_back', installed: false, from: v.version, to: c.latest.version,
        message: `${c.latest.version} didn't start (${unhealthy}). This install is back on ${v.version}; nothing else changed.` } };
    }
    if (!seen || release.compareVersions(c.latest.version, seen) > 0) {
      _writeAtomic(path.join(root, 'runtime', 'seen.json'), JSON.stringify({ highest: c.latest.version }, null, 2));
    }
    packet.log.push(`runtime.install → ${c.latest.version} installed`);
    return { data: { ...checked, status: 'installed', installed: true, from: v.version, to: c.latest.version, package: b.file } };
  } finally {
    unlock();
  }
}

module.exports = { version, check, install, useSource, _internals: { _version, spaceError } };
