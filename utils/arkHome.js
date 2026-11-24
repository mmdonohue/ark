'use strict';

// Where an installation's parts live. Runtime code may be replaced by an
// update; vessels (each one's database, cache, manifest, gateway token)
// never are, so they must not live inside the runtime directory.
//
// The data root, in order:
//   1. ARK_HOME (env)                → <ARK_HOME>/vessels
//   2. install.json beside the code  → its data_root, relative to the
//      runtime directory (a portable install: runtime/<version>/ with
//      "data_root": "../../vessels")
//   3. a developer checkout          → <runtime>/arks, as before (git
//      updates never touch it — the vessels there are gitignored)
//
// install.json (written by a release bundle, absent in a checkout):
//   { mode: 'portable', version, channel?, build?, data_root?, update_source? }

const fs = require('fs');
const path = require('path');

const RUNTIME_ROOT = path.resolve(__dirname, '..');

function installInfo(root = RUNTIME_ROOT) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8'));
    return info && typeof info === 'object' ? info : null;
  } catch { return null; }
}

function vesselsRoot({ env = process.env, root = RUNTIME_ROOT } = {}) {
  if (env.ARK_HOME) return path.resolve(env.ARK_HOME, 'vessels');
  const info = installInfo(root);
  if (info?.data_root) {
    const dataRoot = path.resolve(root, info.data_root);
    // Never inside the code an update replaces.
    if (dataRoot === root || dataRoot.startsWith(root + path.sep)) {
      throw new Error(`install.json data_root (${info.data_root}) is inside the runtime directory — vessels must live outside it`);
    }
    return dataRoot;
  }
  return path.join(root, 'arks');
}

const vesselDir = (name = 'default', opts) => path.join(vesselsRoot(opts), name);

// How this runtime was installed: 'portable' (a release bundle with
// install.json) or 'checkout' (a git working tree, updated with git).
function installMode(root = RUNTIME_ROOT) {
  const info = installInfo(root);
  if (info?.mode) return info.mode;
  return fs.existsSync(path.join(root, '.git')) ? 'checkout' : 'unknown';
}

module.exports = { RUNTIME_ROOT, installInfo, vesselsRoot, vesselDir, installMode };
