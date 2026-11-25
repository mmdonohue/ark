#!/usr/bin/env node
'use strict';

// Lays out a fresh portable ARK install (a USB drive, or any folder) from a
// release bundle — the thing you hand someone.
//
//   node scripts/make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir>
//
//   <dir>/ark, ark.cmd             launchers: run the active version
//   <dir>/runtime/<version>/       the bundle, unpacked
//   <dir>/runtime/current.json     { version, activated_at } — which one is active
//   <dir>/vessels/                 owner data, beside the runtime (never inside)
//
// No symlinks (exFAT has none): the launchers read current.json. Refuses a
// folder that already holds an ARK install — updating one is `ark update`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
function fail(msg) { console.error(msg); process.exit(1); }

const LAUNCHER_SH = `#!/bin/sh
# ARK launcher: runs the active runtime version (runtime/current.json).
HERE="$(cd "$(dirname "$0")" && pwd)"
V=$(sed -n 's/.*"version" *: *"\\([0-9A-Za-z.+-]*\\)".*/\\1/p' "$HERE/runtime/current.json")
if [ -z "$V" ] || [ ! -f "$HERE/runtime/$V/cli/ark.js" ]; then
  echo "ark: no active runtime in $HERE/runtime (current.json)" >&2; exit 1
fi
exec node "$HERE/runtime/$V/cli/ark.js" "$@"
`;

const LAUNCHER_CMD = `@echo off\r
rem ARK launcher: runs the active runtime version (runtime\\current.json).\r
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "%~dp0runtime\\current.json"') do set ARKV=%%v\r
if not exist "%~dp0runtime\\%ARKV%\\cli\\ark.js" (echo ark: no active runtime & exit /b 1)\r
node "%~dp0runtime\\%ARKV%\\cli\\ark.js" %*\r
`;

function main() {
  const bundle = arg('--bundle');
  const to = arg('--to');
  if (!bundle || !to) fail('usage: make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir>');
  const m = /^ark-(.+)-[a-z0-9]+-[a-z0-9_]+\.tar\.gz$/.exec(path.basename(bundle));
  if (!m || !SEMVER.test(m[1])) fail('the bundle must be named ark-<version>-<os>-<arch>.tar.gz');
  const version = m[1];
  const root = path.resolve(to);
  if (fs.existsSync(path.join(root, 'runtime', 'current.json'))) fail(`${root} already holds an ARK install — use "ark update" there instead.`);

  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(root, 'vessels'), { recursive: true });
  // The tarball holds ark-<version>/; it becomes runtime/<version>/.
  const tmp = fs.mkdtempSync(path.join(runtime, '.unpack-'));
  execFileSync('tar', ['-xzf', path.resolve(bundle), '-C', tmp]);
  fs.renameSync(path.join(tmp, `ark-${version}`), path.join(runtime, version));
  fs.rmSync(tmp, { recursive: true, force: true });
  const install = JSON.parse(fs.readFileSync(path.join(runtime, version, 'install.json'), 'utf8'));
  if (install.version !== version || install.mode !== 'portable') fail('the bundle\'s install.json doesn\'t match its name');

  fs.writeFileSync(path.join(runtime, 'current.json'), JSON.stringify({ version, activated_at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(root, 'ark'), LAUNCHER_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ark.cmd'), LAUNCHER_CMD);
  console.log(`ARK ${version} laid out at ${root}. Run: ${path.join(root, 'ark')} version`);
}

main();
