'use strict';

// ark schedule — the one host scheduler for ARK: a launchd agent that runs
// `ark cycle` (system.cycle) on an interval. Owner-run only: nothing here is
// called except by `ark schedule install|status|remove`, and install/remove
// ask first (or take --yes). It only ever touches the agent it wrote itself,
// recognised by MARKER.
//
// Overlap and missed ticks are already safe: system.cycle claims each
// occurrence once and fires only the latest one due.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL  = 'dev.ark.cycle';
const LEGACY = 'dev.ark.watch'; // `ark-dev watch --launchd`, retired: a second loop
const MARKER = '<!-- written by ark schedule; ark schedule remove deletes it -->';
const MIN_S = 5 * 60;
const MAX_S = 24 * 60 * 60;
const DEFAULT_EVERY = '15m';

const agentsDir = () => process.env.ARK_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = (label = LABEL) => path.join(agentsDir(), `${label}.plist`);
const logDir = () => path.join(os.homedir(), '.ark', 'logs');
const domain = () => `gui/${process.getuid()}`;

// '15m' | '1h' | '90m' → seconds, or null.
function parseEvery(v) {
  const m = /^(\d+)\s*(m|h)$/.exec(String(v || '').trim());
  if (!m) return null;
  const s = Number(m[1]) * (m[2] === 'h' ? 3600 : 60);
  return s >= MIN_S && s <= MAX_S ? s : null;
}
const describeEvery = s => (s % 3600 === 0 ? `${s / 3600} h` : `${s / 60} min`);

// What the agent runs: `ark cycle`, the way this install runs. A portable
// install goes through its own launcher (so it picks up the version
// current.json names, and unpacks it if needed); anything else runs this
// CLI with this Node. --ark / --db carry through.
function command({ ark, dbPath } = {}) {
  const root = process.env.ARK_INSTALL_ROOT;
  const base = root ? ['/bin/sh', path.join(root, 'ark')] : [process.execPath, path.join(__dirname, 'ark.js')];
  return [...base, 'cycle', ...(ark ? ['--ark', ark] : []), ...(dbPath ? ['--db', dbPath] : [])];
}

const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist({ args, seconds }) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin' };
  // A checkout picks its vessels from ARK_HOME when set; a portable launcher sets its own.
  if (!process.env.ARK_INSTALL_ROOT && process.env.ARK_HOME) env.ARK_HOME = process.env.ARK_HOME;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${MARKER}
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join('\n')}
  </dict>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(logDir(), 'cycle.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir(), 'cycle.err.log'))}</string>
</dict>
</plist>
`;
}

const launchctl = (...a) => spawnSync(process.env.ARK_LAUNCHCTL || 'launchctl', a, { encoding: 'utf8' });

// → { file, exists, ours, loaded, last_exit, legacy }
function inspect() {
  const file = plistPath();
  const text = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } })();
  const out = { file, exists: text != null, ours: !!text && text.includes(MARKER), loaded: false, last_exit: null, legacy: fs.existsSync(plistPath(LEGACY)) ? plistPath(LEGACY) : null };
  if (text) {
    const s = /<key>StartInterval<\/key><integer>(\d+)<\/integer>/.exec(text);
    if (s) out.seconds = Number(s[1]);
    out.args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] || '').matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  }
  if (process.platform === 'darwin') {
    const r = launchctl('print', `${domain()}/${LABEL}`);
    out.loaded = r.status === 0;
    const m = /last exit code = (-?\d+)/.exec(r.stdout || '');
    if (m) out.last_exit = Number(m[1]);
  }
  return out;
}

function _tail(file, n = 5) {
  try {
    const st = fs.statSync(file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return { at: st.mtime.toISOString(), lines: lines.slice(-n) };
  } catch { return null; }
}

// Cron repeats evenly only for minutes that divide an hour or hours that
// divide a day (45m or 90m would drift: */45 fires at :00 and :45). Those
// get a cron line; anything else gets null and the caller says which work.
const CRON_MINUTES = [5, 6, 10, 12, 15, 20, 30];
const CRON_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];
function cronSchedule(seconds) {
  const min = seconds / 60;
  if (CRON_MINUTES.includes(min)) return `*/${min} * * * *`;
  const hours = seconds / 3600;
  if (!CRON_HOURS.includes(hours)) return null;
  return hours === 24 ? '0 0 * * *' : hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
}

function cronLine({ args, seconds }) {
  const when = cronSchedule(seconds);
  if (!when) return null;
  const q = a => `'${String(a).replace(/'/g, `'\\''`)}'`;
  return `${when} ${args.map(q).join(' ')} >> ${q(path.join(logDir(), 'cycle.log'))} 2>&1`;
}

// A removable drive: the tick fails (and does nothing) while it's unplugged.
const onRemovable = () => {
  const root = process.env.ARK_INSTALL_ROOT;
  return !!root && process.platform === 'darwin' && path.resolve(root).startsWith('/Volumes/');
};

// { out, err, ask(question) → Promise<bool>, yes, tty, every, ark, dbPath } → exit code
async function install({ out, err, ask, yes, tty, every = DEFAULT_EVERY, ark, dbPath }) {
  const seconds = parseEvery(every);
  if (!seconds) { err(`--every takes minutes or hours between ${MIN_S / 60}m and ${MAX_S / 3600}h, e.g. 15m or 1h (got "${every}").`); return 1; }
  const args = command({ ark, dbPath });

  if (process.platform !== 'darwin') {
    const line = cronLine({ args, seconds });
    if (!line) {
      err(`cron can't run every ${describeEvery(seconds)} evenly. Use ${CRON_MINUTES.map(m => `${m}m`).join(', ')} or ${CRON_HOURS.map(x => `${x}h`).join(', ')}.`);
      return 1;
    }
    out('ark schedule installs a launchd agent on macOS. Here, add this line with crontab -e:');
    out(line);
    return 0;
  }
  const cur = inspect();
  if (cur.exists && !cur.ours) { err(`${cur.file} exists and wasn't written by ark schedule. Nothing changed.`); return 1; }
  if (!yes && !tty) { err('ark schedule install asks first — run it in a terminal, or pass --yes.'); return 2; }

  out(`ARK will run "ark cycle" every ${describeEvery(seconds)} while you're logged in:`);
  out(`  ${args.join(' ')}`);
  out(`  agent  ${cur.file}`);
  out(`  logs   ${logDir()}/cycle.log`);
  if (onRemovable()) out(`  note   ${process.env.ARK_INSTALL_ROOT} is a removable drive: while it's unplugged the tick fails and does nothing. ark schedule status shows it.`);
  if (cur.legacy) out(`  note   an old "ark-dev watch" agent is installed (${cur.legacy}), a second loop. Remove it: launchctl bootout ${domain()}/${LEGACY}; rm "${cur.legacy}"`);
  if (cur.exists) out(`  This replaces the schedule installed earlier.`);
  if (!yes && !(await ask('Install it?'))) { out('Not installed.'); return 2; }

  fs.mkdirSync(path.dirname(cur.file), { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });
  fs.writeFileSync(`${cur.file}.tmp`, plist({ args, seconds }));
  fs.renameSync(`${cur.file}.tmp`, cur.file);
  if (cur.loaded) launchctl('bootout', `${domain()}/${LABEL}`);
  const r = launchctl('bootstrap', domain(), cur.file);
  if (r.status !== 0) { err(`Wrote ${cur.file}, but launchctl couldn't load it: ${(r.stderr || r.stdout || '').trim()}`); return 1; }
  out(`Installed. The first tick runs in ${describeEvery(seconds)}. "ark schedule remove" turns it off.`);
  return 0;
}

// { out, unscheduled: [{ id, title }] } → exit code (0 always: it only reports)
function status({ out, unscheduled = [] }) {
  const s = inspect();
  if (!s.exists) out('No ARK schedule installed. "ark schedule install" sets one up.');
  else if (!s.ours) out(`${s.file} wasn't written by ark schedule; leaving it alone.`);
  else {
    out(`schedule  every ${s.seconds ? describeEvery(s.seconds) : '?'} · ${s.loaded ? 'loaded' : 'NOT loaded (run "ark schedule install" again)'}`);
    out(`runs      ${(s.args || []).join(' ')}`);
    if (s.last_exit != null) out(`last exit ${s.last_exit}${s.last_exit ? ' (failed: see the error log)' : ''}`);
    const runner = s.args?.[0] === '/bin/sh' ? s.args[1] : null;
    if (runner && !fs.existsSync(runner)) out(`missing   ${runner} — the drive isn't connected, so ticks fail and do nothing`);
    const log = _tail(path.join(logDir(), 'cycle.log'));
    const errLog = _tail(path.join(logDir(), 'cycle.err.log'), 3);
    out(`last run  ${log ? log.at : 'not yet'}`);
    if (errLog?.lines.length) { out('errors    (cycle.err.log)'); errLog.lines.forEach(l => out(`  ${l}`)); }
  }
  if (s.legacy) out(`legacy    an old "ark-dev watch" agent is installed (${s.legacy}) — a second loop. Remove it: launchctl bootout ${domain()}/${LEGACY}; rm "${s.legacy}"`);
  if (unscheduled.length) {
    out(`Drift tasks with schedule.every but no event to fire them (${unscheduled.length}) — ark cycle won't check them until you schedule one:`);
    unscheduled.forEach(t => out(`  ${t.id.slice(0, 8)}  ${t.title}`));
  }
  return 0;
}

async function remove({ out, err, ask, yes, tty }) {
  const cur = inspect();
  if (!cur.exists) { out('No ARK schedule installed.'); return 0; }
  if (!cur.ours) { err(`${cur.file} wasn't written by ark schedule. Nothing changed.`); return 1; }
  if (!yes && !tty) { err('ark schedule remove asks first — run it in a terminal, or pass --yes.'); return 2; }
  if (!yes && !(await ask('Remove the ARK schedule? ark cycle stops running on its own.'))) { out('Kept.'); return 2; }
  if (process.platform === 'darwin') launchctl('bootout', `${domain()}/${LABEL}`);
  fs.rmSync(cur.file, { force: true });
  out('Removed. Nothing runs ark cycle on its own now.');
  return 0;
}

// Ready drift tasks a schedule.every says should be watched, which no active
// event points at — after `ark-dev watch` retires, nothing would check them.
function unscheduledDriftTasks(tasks, events) {
  const ctx = r => (typeof r.context === 'string' ? JSON.parse(r.context || '{}') : (r.context || {}));
  const targeted = new Set(events.map(ctx).filter(c => c.state === 'active' && c.action_ref?.kind === 'task').map(c => c.action_ref.id));
  return tasks.filter(t => { const c = ctx(t); return c.state === 'ready' && c.inputs?.compare && c.schedule?.every && !targeted.has(t.id); })
    .map(t => ({ id: t.id, title: t.title }));
}

module.exports = { install, status, remove, inspect, parseEvery, plist, command, cronLine, unscheduledDriftTasks, LABEL, MARKER };
