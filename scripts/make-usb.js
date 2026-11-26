#!/usr/bin/env node
'use strict';

// Lays out a portable ARK install (a USB drive, or any folder) from a signed
// release package — the thing you hand someone — or adds a newer package to
// one (--upgrade).
//
//   node scripts/make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir>
//        [--trust <release-keys.json>] [--upgrade] [--unpack auto|host|stick]
//
//   <dir>/Start ARK.command, Start ARK.cmd   double-click: ready mode
//   <dir>/ark, ark.cmd                        launchers
//   <dir>/ark.json                            { unpack: auto | host | stick }
//   <dir>/packages/<bundle>                   signed packages, one file each
//   <dir>/runtime/current.json                { version, package, sha256, previous? }
//   <dir>/vessels/                            owner data — never touched here
//
// Packed: each version stays one file on the drive. Copying it is quick even
// to a slow stick; thousands of small files are not (a cheap FAT32 stick
// writes ~2 files/s). The launcher unpacks a version the first time it runs
// — on that computer (~/.ark/runtime) when it can, else onto the drive —
// after checking the package's sha256 against current.json.
//
// Verification: when release.json + release.json.sig sit beside the bundle,
// the signature is checked against the keys THIS checkout trusts (or
// --trust) and the bundle's name, sha256 and size against the manifest — any
// mismatch refuses; the manifest is kept with the package. Without them it
// warns that the bundle is unverified.
//
// --upgrade adds a package to an existing install (including the earlier,
// unpacked 0.1.0 layout) and makes it current, remembering the previous one
// for rollback. A fresh layout refuses a folder that already holds an
// install. Nothing becomes current until its package has copied and checked
// out; a failure leaves the install as it was.

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const release = require('../utils/release');

const REPO = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNPACK = ['auto', 'host', 'stick'];
function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
const flag = name => process.argv.includes(name);
function fail(msg) { console.error(msg); process.exit(1); }
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// POSIX launcher. Single-quoted lines: nothing here is interpolated by JS.
const LAUNCHER_SH = [
  '#!/bin/sh',
  '# ARK launcher: runs the active version (runtime/current.json) with the Node',
  '# bundled in it. A packed install keeps each version as one signed package in',
  '# packages/; the first launch of a version unpacks it once - on this computer',
  '# (~/.ark/runtime) when it can, else onto this drive (runtime/<version>) -',
  '# after checking its sha256 against current.json. Your data stays here, in',
  '# vessels/, either way. ark.json "unpack": auto | host | stick.',
  'HERE="$(cd "$(dirname "$0")" && pwd -P)"',
  'CUR="$HERE/runtime/current.json"',
  'field() { sed -n "s/.*\\"$1\\" *: *\\"\\([^\\"]*\\)\\".*/\\1/p" "$2" 2>/dev/null | head -n 1; }',
  'die() { echo "ark: $*" >&2; exit 1; }',
  'V=$(field version "$CUR"); PKG=$(field package "$CUR"); SUM=$(field sha256 "$CUR")',
  'case "$V" in ""|*[!0-9A-Za-z.+-]*) die "no active runtime in $HERE/runtime (current.json)";; esac',
  'MODE=$(field unpack "$HERE/ark.json"); [ -n "$MODE" ] || MODE=auto',
  'ARK_HOME="$HERE"; ARK_INSTALL_ROOT="$HERE"; export ARK_HOME ARK_INSTALL_ROOT',
  'if [ -n "$PKG" ]; then',
  '  case "$SUM" in ""|*[!0-9a-f]*) die "current.json has no valid sha256 for $PKG";; esac',
  '  case "$PKG" in */*|.*) die "bad package name in current.json";; esac',
  '  KEY="$V-$(printf %s "$SUM" | cut -c1-12)"',
  '  CACHE="${ARK_RUNTIME_CACHE:-$HOME/.ark/runtime}"',
  '  HOSTDIR="$CACHE/$KEY"; STICKDIR="$HERE/runtime/$V"',
  '  # .complete holds the sha256 it was unpacked from: a same-version rebuild',
  '  # (new package, new sha) is unpacked again, never served from the old copy.',
  '  unpacked() { [ "$(cat "$1/.complete" 2>/dev/null)" = "$SUM" ]; }',
  '  if [ "$MODE" != stick ] && unpacked "$HOSTDIR"; then RT="$HOSTDIR"',
  '  elif [ "$MODE" != host ] && unpacked "$STICKDIR"; then RT="$STICKDIR"',
  '  else',
  '    P="$HERE/packages/$PKG"',
  '    [ -f "$P" ] || die "package $PKG is missing from $HERE/packages"',
  '    GOT=$( (shasum -a 256 "$P" 2>/dev/null || sha256sum "$P") | cut -d" " -f1)',
  '    [ "$GOT" = "$SUM" ] || die "$PKG does not match the sha256 in current.json - refusing to unpack it"',
  '    if [ "$MODE" != stick ] && mkdir -p "$CACHE" 2>/dev/null && [ -w "$CACHE" ]; then TARGET="$HOSTDIR"',
  '    elif [ "$MODE" != host ]; then TARGET="$STICKDIR"',
  '    else die "cannot write to $CACHE, and ark.json says unpack: host"; fi',
  '    if [ "$TARGET" = "$STICKDIR" ]; then echo "ark: unpacking ARK $V onto this drive - slow on some drives, but only once per version..." >&2',
  '    else echo "ark: unpacking ARK $V on this computer (once per version)..." >&2; fi',
  '    TMP="$TARGET.partial.$$"',
  '    rm -rf "$TMP"; mkdir -p "$TMP" || die "cannot write $TMP"',
  '    NOMETA=""; tar --version 2>/dev/null | grep -q bsdtar && NOMETA="--no-xattrs --no-mac-metadata"',
  '    tar $NOMETA -xzf "$P" -C "$TMP" || { rm -rf "$TMP"; die "unpacking $PKG failed"; }',
  '    [ -f "$TMP/ark-$V/cli/ark.js" ] || { rm -rf "$TMP"; die "$PKG has no ark-$V/cli/ark.js"; }',
  '    printf %s "$SUM" > "$TMP/ark-$V/.complete"',
  '    if unpacked "$TARGET"; then rm -rf "$TMP"',
  '    else rm -rf "$TARGET"; mv "$TMP/ark-$V" "$TARGET" || { rm -rf "$TMP"; die "could not move the unpacked runtime into place"; }; rm -rf "$TMP"; fi',
  '    RT="$TARGET"',
  '  fi',
  'else',
  '  # An unpacked install (the 0.1.0 layout): runtime/<version>/ on the drive.',
  '  RT="$HERE/runtime/$V"',
  '  [ -f "$RT/cli/ark.js" ] || die "no active runtime in $HERE/runtime (current.json)"',
  'fi',
  'NODE="$RT/node/bin/node"; [ -x "$NODE" ] || NODE=node',
  'exec "$NODE" "$RT/cli/ark.js" "$@"',
  '',
].join('\n');

// Windows: no Windows bundles are built yet (release-build refuses win32),
// so this runs an unpacked runtime/<version>/ and says so for a packed one.
const LAUNCHER_CMD = [
  '@echo off',
  'rem ARK launcher: runs the active runtime version (runtime\\current.json).',
  'set ARKV=',
  'set ARKPKG=',
  // First match only: current.json's nested "previous" has these keys too.
  'for /f "tokens=2 delims=:," %%v in (\'findstr /c:"\\"version\\"" "%~dp0runtime\\current.json"\') do if not defined ARKV set ARKV=%%~v',
  'for /f "tokens=2 delims=:," %%v in (\'findstr /c:"\\"package\\"" "%~dp0runtime\\current.json"\') do if not defined ARKPKG set ARKPKG=%%~v',
  'set ARKV=%ARKV: =%',
  'set ARK_HOME=%~dp0.',
  'set ARK_INSTALL_ROOT=%~dp0.',
  'if not exist "%~dp0runtime\\%ARKV%\\cli\\ark.js" (if defined ARKPKG (echo ark: packed installs are not supported on Windows yet & exit /b 1) else (echo ark: no active runtime & exit /b 1))',
  'set ARKNODE=%~dp0runtime\\%ARKV%\\node\\node.exe',
  'if not exist "%ARKNODE%" set ARKNODE=node',
  '"%ARKNODE%" "%~dp0runtime\\%ARKV%\\cli\\ark.js" %*',
  '',
].join('\r\n');

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

// The signed manifest beside the bundle, checked; null when there is none.
function verify(bundle) {
  const dir = path.dirname(bundle);
  const mPath = path.join(dir, 'release.json');
  const sPath = path.join(dir, 'release.json.sig');
  if (!fs.existsSync(mPath) || !fs.existsSync(sPath)) return null;
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
  if (sha256(bundle) !== entry.sha256) fail(`${path.basename(bundle)} doesn't match release.json's sha256 — refusing.`);
  console.log(`Verified ${m.version} against release.json, signed by ${keyId}.`);
  return { manifest: mPath, signature: sPath };
}

// The bundle's own install.json and entry point, read without unpacking it.
function inspect(bundle, version) {
  let install = null;
  try { install = JSON.parse(execFileSync('tar', ['-xzOf', bundle, `ark-${version}/install.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* checked below */ }
  if (!install || install.version !== version || install.mode !== 'portable') fail('Not laid out: the bundle\'s install.json doesn\'t match its name.');
  const listing = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!listing.split('\n').includes(`ark-${version}/cli/ark.js`)) fail('Not laid out: the bundle has no cli/ark.js.');
}

// Copies the package to packages/ and checks the copy (a flaky drive can
// write bad bytes); the old package, if any, is untouched until it succeeds.
function placePackage(root, bundle, proof) {
  const dir = path.join(root, 'packages');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(bundle));
  const part = `${dest}.part`;
  fs.copyFileSync(bundle, part);
  const sum = sha256(bundle);
  if (sha256(part) !== sum) { fs.rmSync(part, { force: true }); fail(`The copy of ${path.basename(bundle)} on ${root} came out different — the drive may be failing. Nothing changed.`); }
  fs.renameSync(part, dest);
  if (proof) {
    fs.copyFileSync(proof.manifest, `${dest}.release.json`);
    fs.copyFileSync(proof.signature, `${dest}.release.json.sig`);
  }
  return sum;
}

function writeLaunchers(root, { keepSettings }) {
  fs.writeFileSync(path.join(root, 'ark'), LAUNCHER_SH, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ark.cmd'), LAUNCHER_CMD);
  fs.writeFileSync(path.join(root, 'Start ARK.command'), START_COMMAND, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'Start ARK.cmd'), START_CMD);
  const settings = path.join(root, 'ark.json');
  const unpack = arg('--unpack');
  if (unpack && !UNPACK.includes(unpack)) fail(`--unpack must be one of ${UNPACK.join(', ')}`);
  if (!keepSettings || unpack || !fs.existsSync(settings)) {
    fs.writeFileSync(settings, JSON.stringify({ unpack: unpack || 'auto' }, null, 2));
  }
}

// current.json changes by write-then-rename: a pulled drive leaves the old
// one or the new one, never half of either.
function writeCurrent(root, current) {
  const file = path.join(root, 'runtime', 'current.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(current, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function main() {
  const bundle = arg('--bundle') && path.resolve(arg('--bundle'));
  const to = arg('--to');
  if (!bundle || !to) fail('usage: make-usb.js --bundle <ark-x.y.z-os-arch.tar.gz> --to <dir> [--upgrade] [--unpack auto|host|stick]');
  const m = /^ark-(.+)-[a-z0-9]+-[a-z0-9_]+\.tar\.gz$/.exec(path.basename(bundle));
  if (!m || !SEMVER.test(m[1])) fail('the bundle must be named ark-<version>-<os>-<arch>.tar.gz');
  const version = m[1];
  const root = path.resolve(to);
  const currentFile = path.join(root, 'runtime', 'current.json');
  const upgrade = flag('--upgrade');
  let previous = null;
  if (upgrade) {
    try { previous = JSON.parse(fs.readFileSync(currentFile, 'utf8')); } catch { fail(`${root} holds no ARK install to upgrade — leave out --upgrade to lay out a new one.`); }
    if (previous.version === version && previous.package === path.basename(bundle)) fail(`${root} already runs ARK ${version}.`);
  } else if (fs.existsSync(currentFile)) {
    fail(`${root} already holds an ARK install — add a version with --upgrade (or "ark update" there).`);
  }

  const proof = verify(bundle);
  if (!proof) console.warn('warning: no release.json beside the bundle — it is NOT verified. Only use a bundle you built or received from a trusted source.');
  inspect(bundle, version);

  const sum = placePackage(root, bundle, proof);
  fs.mkdirSync(path.join(root, 'vessels'), { recursive: true });
  writeLaunchers(root, { keepSettings: upgrade });
  writeCurrent(root, {
    version, package: path.basename(bundle), sha256: sum, activated_at: new Date().toISOString(),
    ...(previous ? { previous: { version: previous.version, ...(previous.package ? { package: previous.package, sha256: previous.sha256 } : {}) } } : {}),
  });
  console.log(upgrade
    ? `ARK ${previous.version} → ${version} on ${root}. It unpacks on its next start; your vessels are untouched.`
    : `ARK ${version} laid out at ${root}. Double-click "Start ARK" there, or run: ${path.join(root, 'ark')}`);
}

main();
