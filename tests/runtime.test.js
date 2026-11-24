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

test('installMode: portable from install.json, checkout from .git, unknown otherwise', () => {
  assert.equal(home.installMode(portable({ mode: 'portable' }).runtime), 'portable');
  const co = portable(null);
  fs.mkdirSync(path.join(co.runtime, '.git'));
  assert.equal(home.installMode(co.runtime), 'checkout');
  assert.equal(home.installMode(portable(null).runtime), 'unknown');
  assert.equal(home.installInfo(portable(null).runtime), null);
  const broken = portable(null);
  fs.writeFileSync(path.join(broken.runtime, 'install.json'), '{not json');
  assert.equal(home.installInfo(broken.runtime), null, 'unreadable install.json is ignored, not fatal');
});

test('the CLI keeps vessels under ARK_HOME, outside the runtime', () => {
  const arkHome = path.join(TMP, 'home');
  execFileSync(process.execPath, [path.resolve(__dirname, '../cli/ark.js'), 'ls', 'note', '--ark', 'outside'], {
    env: { ...process.env, ARK_HOME: arkHome }, stdio: 'pipe',
  });
  assert.ok(fs.existsSync(path.join(arkHome, 'vessels', 'outside', 'ark.sqlite')), 'the vessel was created under ARK_HOME');
  assert.ok(!fs.existsSync(path.resolve(__dirname, '../arks/outside')), 'not inside the runtime');
});
