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
const { RUNTIME_ROOT, installInfo, installMode, vesselsRoot } = require('../utils/arkHome');
const release = require('../utils/release');

function _version(root = RUNTIME_ROOT) {
  const info = installInfo(root) || {};
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let build = info.build || null;
  if (!build && fs.existsSync(path.join(root, '.git'))) {
    try { build = execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a usable checkout */ }
  }
  return {
    version: info.version || pkg.version,
    build,
    channel: info.channel || (installMode(root) === 'checkout' ? 'dev' : null),
    install: installMode(root),
    runtime_dir: root,
    vessels_dir: vesselsRoot({ root }),
    platform: release.platformKey(),
    node: process.versions.node,
    update_source: info.update_source || process.env.ARK_UPDATE_SOURCE || null,
  };
}

async function version(ctx, payload, packet) {
  const v = _version();
  packet.log.push(`runtime.version → ${v.version} (${v.install})`);
  return { data: v };
}

// payload: { source? } — defaults to install.json update_source, then ARK_UPDATE_SOURCE.
async function check(ctx, payload, packet) {
  const v = _version();
  const source = payload.source || v.update_source;
  const result = await release.check({ source, current: v.version, channel: v.channel === 'dev' ? null : v.channel, keys: release.loadTrustedKeys(RUNTIME_ROOT) });
  // A checkout updates with git; say so rather than offer a bundle.
  const note = v.install === 'checkout' ? 'This is a developer checkout: update it with git, not with a release bundle.' : null;
  packet.log.push(`runtime.check → ${result.status}${result.latest ? ` (${result.latest.version})` : ''}`);
  return { data: { ...result, install: v.install, ...(note ? { note } : {}) } };
}

module.exports = { version, check, _internals: { _version } };
