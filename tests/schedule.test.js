'use strict';

// ark schedule: the owner-run launchd agent for `ark cycle`. Runs the real
// CLI against a temp LaunchAgents folder and a fake launchctl, so nothing
// here touches the machine's own agents.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const schedule = require('../cli/schedule');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-schedule-test-'));
const CLI = path.resolve(__dirname, '../cli/ark.js');
const DEV = path.resolve(__dirname, '../cli/ark-dev.js');
const mac = process.platform === 'darwin';

// A fake launchctl: logs every call; `print` succeeds while bootstrapped.
function env(name, extra = {}) {
  const dir = path.join(TMP, name);
  const home = path.join(dir, 'home');
  const agents = path.join(dir, 'agents');
  fs.mkdirSync(home, { recursive: true });
  const log = path.join(dir, 'launchctl.log');
  const flag = path.join(dir, 'loaded');
  const bin = path.join(dir, 'launchctl');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  bootstrap) touch "${flag}" ;;
  bootout) rm -f "${flag}" ;;
  print) [ -f "${flag}" ] || exit 113; echo "state = not running"; echo "last exit code = 0" ;;
esac
`);
  fs.chmodSync(bin, 0o755);
  const e = { ...process.env, HOME: home, ARK_HOME: path.join(dir, 'ark-home'), ARK_LAUNCH_AGENTS: agents, ARK_LAUNCHCTL: bin, ...extra };
  delete e.ARK_INSTALL_ROOT;
  if (extra.ARK_INSTALL_ROOT) e.ARK_INSTALL_ROOT = extra.ARK_INSTALL_ROOT;
  const cli = (...a) => { const r = spawnSync(process.execPath, [CLI, 'schedule', ...a], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { cli, plist: path.join(agents, `${schedule.LABEL}.plist`), agents, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []), env: e };
}

test('--every: minutes or hours, 5 min to 24 h', () => {
  assert.equal(schedule.parseEvery('15m'), 900);
  assert.equal(schedule.parseEvery('1h'), 3600);
  assert.equal(schedule.parseEvery('90m'), 5400);
  for (const bad of ['4m', '25h', '15', 'often', '', null]) assert.equal(schedule.parseEvery(bad), null, String(bad));
});

test('drift tasks with schedule.every and no active event are reported, nothing else', () => {
  const t = (id, c) => ({ id, title: id, context: c });
  const drift = { state: 'ready', inputs: { compare: {} }, schedule: { every: '1d' } };
  const tasks = [t('lonely', drift), t('scheduled', drift), t('paused-event', drift), t('proposed', { ...drift, state: 'proposed' }), t('plain', { state: 'ready', schedule: { every: '1d' } })];
  const events = [
    { context: JSON.stringify({ state: 'active', action_ref: { kind: 'task', id: 'scheduled' } }) },
    { context: { state: 'paused', action_ref: { kind: 'task', id: 'paused-event' } } },
  ];
  assert.deepEqual(schedule.unscheduledDriftTasks(tasks, events).map(x => x.id), ['lonely', 'paused-event']);
});

test('non-macOS: install prints a cron line and writes nothing', () => {
  const line = schedule.cronLine({ args: ['/usr/bin/node', "/a b/ark.js", 'cycle'], seconds: 900 });
  assert.match(line, /^\*\/15 \* \* \* \* '\/usr\/bin\/node' '\/a b\/ark\.js' 'cycle' >> '.*cycle\.log' 2>&1$/);
  const when = s => schedule.cronLine({ args: ['x'], seconds: s })?.split(" 'x'")[0] ?? null;
  assert.equal(when(7200), '0 */2 * * *');
  assert.equal(when(3600), '0 * * * *');
  assert.equal(when(86400), '0 0 * * *');
  assert.equal(when(1800), '*/30 * * * *');
  // Cron can't repeat these evenly (*/45 fires at :00 and :45): refused, not approximated.
  for (const s of [45 * 60, 90 * 60, 25 * 60, 5 * 3600]) assert.equal(when(s), null, `${s / 60} min`);
});

test('ark schedule: asks first, installs, reports, replaces, removes — only its own agent', { skip: !mac && 'launchd is macOS only' }, () => {
  const s = env('roundtrip');

  // Nothing installed: status says so, remove is a no-op.
  assert.match(s.cli('status').out, /No ARK schedule installed/);
  assert.equal(s.cli('remove').code, 0);

  // No terminal and no --yes: refused before anything is written.
  const refused = s.cli('install');
  assert.equal(refused.code, 2);
  assert.match(refused.err, /asks first/);
  assert.ok(!fs.existsSync(s.plist));
  assert.equal(s.cli('install', '--every', '3m', '--yes').code, 1, 'too often');

  const inst = s.cli('install', '--every', '1h', '--yes');
  assert.equal(inst.code, 0, inst.err);
  assert.match(inst.out, /run "ark cycle" every 1 h/);
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.ok(text.includes(schedule.MARKER));
  assert.match(text, /<key>StartInterval<\/key><integer>3600<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key><false\/>/);
  assert.ok(text.includes(`<string>${CLI}</string>`) && text.includes('<string>cycle</string>'), 'runs this CLI\'s ark cycle');
  assert.ok(text.includes(`<key>ARK_HOME</key><string>${s.env.ARK_HOME}</string>`), 'a checkout keeps its ARK_HOME');
  assert.deepEqual(s.calls().filter(c => !c.startsWith('print')), [`bootstrap gui/${process.getuid()} ${s.plist}`]);

  const st = s.cli('status');
  assert.match(st.out, /schedule  every 1 h · loaded/);
  assert.match(st.out, /last exit 0/);
  assert.match(st.out, /last run  not yet/);

  // Installing again replaces it: unloaded first, then loaded again.
  assert.equal(s.cli('install', '--yes').code, 0);
  assert.match(fs.readFileSync(s.plist, 'utf8'), /<integer>900<\/integer>/, 'default every 15 min');
  assert.deepEqual(s.calls().filter(c => !c.startsWith('print')).slice(-2), [`bootout gui/${process.getuid()}/${schedule.LABEL}`, `bootstrap gui/${process.getuid()} ${s.plist}`]);

  assert.equal(s.cli('remove').code, 2, 'remove asks first too');
  const rm = s.cli('remove', '--yes');
  assert.equal(rm.code, 0);
  assert.ok(!fs.existsSync(s.plist));
  assert.match(s.cli('status').out, /No ARK schedule installed/);
  assert.deepEqual(fs.readdirSync(s.agents), [], 'nothing left behind');
});

test('ark schedule never touches an agent it didn\'t write, and flags the retired ark-dev watch agent', { skip: !mac && 'launchd is macOS only' }, () => {
  const s = env('foreign');
  fs.mkdirSync(s.agents, { recursive: true });
  fs.writeFileSync(s.plist, '<plist>someone else\'s</plist>');
  fs.writeFileSync(path.join(s.agents, 'dev.ark.watch.plist'), '<plist>old</plist>');
  const inst = s.cli('install', '--yes');
  assert.equal(inst.code, 1);
  assert.match(inst.err, /wasn't written by ark schedule\. Nothing changed/);
  assert.equal(s.cli('remove', '--yes').code, 1);
  assert.equal(fs.readFileSync(s.plist, 'utf8'), '<plist>someone else\'s</plist>');
  assert.match(s.cli('status').out, /old "ark-dev watch" agent is installed[\s\S]*second loop/);
  assert.deepEqual(s.calls().filter(c => !c.startsWith('print')), [], 'launchctl never asked to load or unload anything');
});

test('a portable install schedules through its launcher, and says when the drive is missing', { skip: !mac && 'launchd is macOS only' }, () => {
  const root = '/Volumes/ARK-TEST-NOT-MOUNTED/ARK';
  const s = env('portable', { ARK_INSTALL_ROOT: root });
  const inst = s.cli('install', '--yes');
  assert.equal(inst.code, 0, inst.err);
  assert.match(inst.out, /removable drive: while it's unplugged the tick fails and does nothing/);
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.ok(text.includes(`<string>/bin/sh</string>\n    <string>${root}/ark</string>\n    <string>cycle</string>`), text);
  assert.ok(!text.includes('ARK_HOME'), 'the launcher sets its own ARK_HOME');
  assert.match(s.cli('status').out, /missing   \/Volumes\/ARK-TEST-NOT-MOUNTED\/ARK\/ark — the drive isn't connected/);
});

test('ark-dev watch --launchd is retired and points at ark schedule', () => {
  const r = spawnSync(process.execPath, [DEV, 'watch', '--launchd'], { encoding: 'utf8', env: { ...process.env, ARK_HOME: path.join(TMP, 'dev-home') } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /retired: "ark cycle" is the one scheduled tick[\s\S]*ark schedule install/);
  assert.equal(r.stdout, '', 'no plist printed');
});
