'use strict';

// RuntimeActions — the ARK runtime itself (not artifacts: ark.update is the
// artifact action). Owner-only reads for now; installing comes later.
//
//   runtime.version  what is installed: version, build, channel, install
//                    mode, where vessels live, host platform and Node
//   runtime.check    whether a newer verified release exists (read-only:
//                    fetches the signed manifest, never a bundle)

const { execFileSync } = require('child_process');
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
  const result = await release.check({ source, current: v.version, channel: v.channel === 'dev' ? null : v.channel, keys: release.loadTrustedKeys(RUNTIME_ROOT) });
  // A checkout updates with git; say so rather than offer a bundle.
  const note = {
    checkout: 'This is a developer checkout: update it with git, not with a release bundle.',
    embedded: 'This ARK is embedded in a host app: it updates with the host, not with a release bundle.',
  }[v.install] || null;
  packet.log.push(`runtime.check → ${result.status}${result.latest ? ` (${result.latest.version})` : ''}`);
  return { data: { ...result, install: v.install, ...(note ? { note } : {}) } };
}

module.exports = { version, check, useSource, _internals: { _version } };
