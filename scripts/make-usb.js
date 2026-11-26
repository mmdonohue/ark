#!/usr/bin/env node
'use strict';

// Lays out a fresh portable ARK install (a USB drive, or any folder) from a
// release bundle — the thing you hand someone.
//
//   node scripts/make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir> [--trust <release-keys.json>]
//
//   <dir>/ark, ark.cmd             launchers: run the active version
//   <dir>/runtime/<version>/       the bundle, unpacked
//   <dir>/runtime/current.json     { version, activated_at } — which one is active
//   <dir>/vessels/                 owner data, beside the runtime (never inside)
//
// Verification: when release.json + release.json.sig sit beside the bundle,
// the signature is checked against the keys THIS checkout trusts (or
// --trust <release-keys.json>) and the
// bundle's name, sha256 and size against the manifest — any mismatch
// refuses. Without them it warns that the bundle is unverified.
//
// No symlinks (exFAT has none): the launchers read current.json. Refuses a
// folder that already holds an ARK install (or a leftover partial one) —
// updating one is `ark update`. Nothing is moved into place until the
// bundle has checked out; a failure leaves the folder as it was.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const release = require('../utils/release');

const REPO = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
function fail(msg) { console.error(msg); process.exit(1); }

// Both launchers run the active version with the Node bundled in it
// (runtime/<v>/node/), falling back to the host's only for a bundle built
// without one. Neither needs Node just to read current.json.
const LAUNCHER_SH = `#!/bin/sh
# ARK launcher: runs the active runtime version (runtime/current.json).
HERE="$(cd "$(dirname "$0")" && pwd)"
V=$(sed -n 's/.*"version" *: *"\\([0-9A-Za-z.+-]*\\)".*/\\1/p' "$HERE/runtime/current.json")
if [ -z "$V" ] || [ ! -f "$HERE/runtime/$V/cli/ark.js" ]; then
  echo "ark: no active runtime in $HERE/runtime (current.json)" >&2; exit 1
fi
NODE="$HERE/runtime/$V/node/bin/node"
[ -x "$NODE" ] || NODE=node
exec "$NODE" "$HERE/runtime/$V/cli/ark.js" "$@"
`;

const LAUNCHER_CMD = `@echo off\r
rem ARK launcher: runs the active runtime version (runtime\\current.json).\r
set ARKV=\r
for /f "tokens=2 delims=:," %%v in ('findstr /c:"\\"version\\"" "%~dp0runtime\\current.json"') do set ARKV=%%~v\r
set ARKV=%ARKV: =%\r
if not exist "%~dp0runtime\\%ARKV%\\cli\\ark.js" (echo ark: no active runtime & exit /b 1)\r
set ARKNODE=%~dp0runtime\\%ARKV%\\node\\node.exe\r
if not exist "%ARKNODE%" set ARKNODE=node\r
"%ARKNODE%" "%~dp0runtime\\%ARKV%\\cli\\ark.js" %*\r
`;

// Double-click files: ready mode (`ark start` — setup on first use, then
// Mission Control in the browser). Named so they don't collide with ark.cmd
// on case-insensitive Windows. The window stays open after ARK stops so any
// message can be read.
const START_COMMAND = `#!/bin/sh
# Double-click to start ARK (macOS).
cd "$(dirname "$0")" || exit 1
./ark start
status=$?
echo
printf 'ARK has stopped. Press Return to close this window. '
read _
exit $status
`;

const START_CMD = `@echo off\r
rem Double-click to start ARK (Windows).\r
call "%~dp0ark.cmd" start\r
echo.\r
pause\r
`;

// → null when verified, 'unverified' when there's nothing to verify against;
// exits on a mismatch.
function verify(bundle) {
  const dir = path.dirname(bundle);
  const mPath = path.join(dir, 'release.json');
  const sPath = path.join(dir, 'release.json.sig');
  if (!fs.existsSync(mPath) || !fs.existsSync(sPath)) return 'unverified';
  const bytes = fs.readFileSync(mPath);
  // The keys to verify with: --trust <release-keys.json>, else this checkout's.
  const keys = arg('--trust') ? JSON.parse(fs.readFileSync(path.resolve(arg('--trust')), 'utf8')) : release.loadTrustedKeys(REPO);
  const keyId = release.verifySignature(bytes, fs.readFileSync(sPath), Array.isArray(keys) ? keys : []);
  if (!keyId) fail('release.json beside the bundle is not signed by a trusted key — refusing.');
  const m = JSON.parse(bytes.toString('utf8'));
  const entry = Object.values(m.platforms || {}).find(b => b.file === path.basename(bundle));
  if (!entry) fail(`release.json lists no bundle named ${path.basename(bundle)} — refusing.`);
  const st = fs.statSync(bundle);
  if (st.size !== entry.size) fail(`${path.basename(bundle)} is ${st.size} bytes; release.json says ${entry.size} — refusing.`);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
  if (digest !== entry.sha256) fail(`${path.basename(bundle)} doesn't match release.json's sha256 — refusing.`);
  console.log(`Verified ${m.version} against release.json, signed by ${keyId}.`);
  return null;
}

function main() {
  const bundle = arg('--bundle') && path.resolve(arg('--bundle'));
  const to = arg('--to');
  if (!bundle || !to) fail('usage: make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir>');
  const m = /^ark-(.+)-[a-z0-9]+-[a-z0-9_]+\.tar\.gz$/.exec(path.basename(bundle));
  if (!m || !SEMVER.test(m[1])) fail('the bundle must be named ark-<version>-<os>-<arch>.tar.gz');
  const version = m[1];
  const root = path.resolve(to);
  const runtime = path.join(root, 'runtime');
  if (fs.existsSync(path.join(runtime, 'current.json'))) fail(`${root} already holds an ARK install — use "ark update" there instead.`);
  if (fs.existsSync(path.join(runtime, version))) fail(`${path.join(runtime, version)} already exists without an active install (a partial one?) — remove it and try again.`);

  if (verify(bundle)) console.warn('warning: no release.json beside the bundle — it is NOT verified. Only use a bundle you built or received from a trusted source.');

  // Unpack and check, then move into place: nothing lands until it's right.
  fs.mkdirSync(runtime, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(runtime, '.unpack-'));
  try {
    execFileSync('tar', ['-xzf', bundle, '-C', tmp]);
    const unpacked = path.join(tmp, `ark-${version}`);
    let install = null;
    try { install = JSON.parse(fs.readFileSync(path.join(unpacked, 'install.json'), 'utf8')); } catch { /* checked below */ }
    if (!install || install.version !== version || install.mode !== 'portable') throw new Error('the bundle\'s install.json doesn\'t match its name');
    if (!fs.existsSync(path.join(unpacked, 'cli', 'ark.js'))) throw new Error('the bundle has no cli/ark.js');
    fs.renameSync(unpacked, path.join(runtime, version));
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.readdirSync(runtime).length) fs.rmSync(runtime, { recursive: true, force: true });
    fail(`Not laid out: ${err.message}. ${root} is unchanged.`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  fs.mkdirSync(path.join(root, 'vessels'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'current.json'), JSON.stringify({ version, activated_at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(root, 'ark'), LAUNCHER_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ark.cmd'), LAUNCHER_CMD);
  fs.writeFileSync(path.join(root, 'Start ARK.command'), START_COMMAND, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'Start ARK.cmd'), START_CMD);
  console.log(`ARK ${version} laid out at ${root}. Double-click "Start ARK" there, or run: ${path.join(root, 'ark')}`);
}

main();
