'use strict';

// HarnessAdapter — Manifest service 'harness'. A replaceable external agent
// harness, bound like 'llm': ARK owns the task, authority and ledger; the
// harness owns the agent loop, model and tools. Nothing above this file knows
// which harness ran — swapping one is a config change.
//
// Drivers are local CLIs run headless against a throwaway snapshot dir (see
// utils/snapshot.js). Config order is preference order; with `failover: true`
// a run that hits a limit on one driver moves to the next, and every attempt
// is returned so the caller can ledger it — failover is never silent.
//
// Limits are checked twice:
//   pre-flight — our own caps per driver (runs/day, USD/day), plus any
//                provider cooldown recorded by an earlier run
//   reactive   — the provider says it's rate-limited/out of budget/unauthed;
//                the driver goes on cooldown and the run fails over
// Usage and cooldowns persist next to the config file (`<config>.state.json`)
// so short-lived CLI runs (ark-dev dispatch) see each other's limits.
//
// Config: config.harness from the host, else the JSON file named by
// ARK_HARNESS_CONFIG (same env-fallback posture as LLMAdapter). Absent =
// no drivers = every capability unavailable; nothing is ever installed.
//
//   {
//     "allowed_roots": ["/abs/path/to/workspaces"],
//     "failover": true,
//     "drivers": [
//       { "name": "claude",  "kind": "claude-code", "bin": "claude",
//         "limits": { "timeout_ms": 900000, "max_budget_usd": 2, "max_usd_per_day": 10, "max_runs_per_day": 20 } },
//       { "name": "copilot", "kind": "copilot", "bin": "copilot",
//         "limits": { "timeout_ms": 900000, "max_ai_credits": 60, "max_requests_per_day": 50 } }
//     ]
//   }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_TTL_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const AUTH_COOLDOWN_MS = 60 * 60 * 1000;

// Codes a run may fail over on. TIMEOUT is deliberately absent: a hung agent
// is as likely to be our prompt or snapshot as the provider, and re-running a
// 15-minute job on the next driver doubles the cost of finding that out.
const FAILOVER_CODES = new Set(['HARNESS_UNAVAILABLE', 'LIMIT_REACHED', 'RATE_LIMITED', 'AUTH_FAILED', 'BUDGET_EXCEEDED', 'PROVIDER_ERROR']);

// The child gets PATH/HOME and little else — the backend's env carries
// Supabase/Stripe/OpenRouter secrets that a harness has no business seeing.
// CLIs authenticate from their own stored login (keychain / ~/.config).
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];

class HarnessError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const READ_ONLY_CAPS = ['repo.read', 'code.review', 'report.write'];
// Reached through the ark MCP shim (req.mcp), which both CLIs can load.
// What the agent can actually do there is the task's grant, enforced by
// the callback in HarnessActions — these only say the driver can carry it.
const ARK_CAPS = ['artifact.read', 'ledger.read', 'task.propose'];
const MCP_SERVER = 'ark';
const MCP_TOOL = 'ark_dispatch';

// ── Drivers ──────────────────────────────────────────────────────────────────
// Each kind maps a normalized request to argv/stdin and maps raw output back to
// { ok, report, model?, cost_usd?, denials? } or { ok:false, code, message, retry_at? }.

const KINDS = {
  'claude-code': {
    capabilities: [...READ_ONLY_CAPS, ...ARK_CAPS],
    mcpConfig: (m) => ({ mcpServers: { [MCP_SERVER]: { type: 'stdio', command: m.command, args: m.args, env: m.env } } }),
    // --restricted drops code-running tools and confines file tools to cwd;
    // --tools narrows further to read-only; dontAsk denies anything else
    // instead of waiting on a prompt nobody will answer.
    build(req, spec) {
      const args = [
        '-p',
        '--restricted', '--strict-mcp-config',
        '--tools', 'Read,Grep,Glob',
        '--permission-mode', 'dontAsk',
        '--output-format', 'json',
        '--no-session-persistence',
      ];
      if (spec.limits?.max_budget_usd) args.push('--max-budget-usd', String(spec.limits.max_budget_usd));
      if (req.model || spec.model) args.push('--model', req.model || spec.model);
      if (req.mcpConfigPath) args.push('--mcp-config', req.mcpConfigPath, '--allowedTools', `mcp__${MCP_SERVER}__${MCP_TOOL}`);
      return { args, stdin: req.prompt };
    },
    parse({ stdout, stderr, exitCode }) {
      let out;
      try { out = JSON.parse(stdout.trim().split('\n').pop()); } catch { out = null; }
      if (!out) return classifyText(`${stdout}\n${stderr}`, exitCode);
      if (!out.is_error && out.subtype === 'success') {
        return {
          ok: true,
          report: out.result || '',
          model: Object.keys(out.modelUsage || {})[0] || null,
          cost_usd: out.total_cost_usd ?? null,
          denials: (out.permission_denials || []).map(d => d.tool_name || d.tool || String(d)),
          turns: out.num_turns ?? null,
        };
      }
      if (out.subtype === 'error_max_budget_usd') return { ok: false, code: 'BUDGET_EXCEEDED', message: 'per-run budget reached' };
      const status = out.api_error_status;
      if (status === 429) return { ok: false, code: 'RATE_LIMITED', message: out.result || 'rate limited', retry_at: parseReset(out.result) };
      if (status === 401 || status === 403) return { ok: false, code: 'AUTH_FAILED', message: out.result || `HTTP ${status}` };
      return classifyText(out.result || stderr || `error: ${out.subtype}`, exitCode || 1);
    },
  },

  // GitHub Copilot CLI as a coding agent (not Copilot-as-LLM-provider).
  // Verified against 1.0.106: prompt piped on stdin; --available-tools hides
  // everything but its three read tools from the model (the deny rules are a
  // second layer); builtin GitHub MCP off; no self-update mid-run (that would
  // be exactly the silent environment mutation ARK refuses to do). Cost is
  // premium requests, not USD — limited by max_requests_per_day.
  copilot: {
    capabilities: [...READ_ONLY_CAPS, ...ARK_CAPS],
    mcpConfig: (m) => ({ mcpServers: { [MCP_SERVER]: { type: 'local', command: m.command, args: m.args, env: m.env, tools: [MCP_TOOL] } } }),
    build(req, spec) {
      const args = [
        '--output-format', 'json',
        `--available-tools=view,grep,glob${req.mcpConfigPath ? `,${MCP_SERVER}-${MCP_TOOL}` : ''}`,
        '--deny-tool=write', '--deny-tool=shell', '--deny-tool=memory',
        '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user',
        '--no-auto-update', '--no-color', '--log-level', 'none',
      ];
      if (spec.limits?.max_ai_credits) args.push('--max-ai-credits', String(spec.limits.max_ai_credits));
      if (req.mcpConfigPath) args.push(`--additional-mcp-config=@${req.mcpConfigPath}`, `--allow-tool=${MCP_SERVER}`);
      if (req.model || spec.model) args.push('--model', req.model || spec.model);
      return { args, stdin: req.prompt };
    },
    parse({ stdout, stderr, exitCode }) {
      const events = stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = events.find(e => e.type === 'result');
      const messages = events.filter(e => e.type === 'assistant.message' && e.data?.content);
      const report = messages.length ? messages[messages.length - 1].data.content : '';
      const code = result?.exitCode ?? exitCode;
      if (code === 0 && report) {
        return {
          ok: true,
          report,
          model: events.find(e => e.data?.model)?.data.model || null,
          cost_usd: null,
          requests: result?.usage?.premiumRequests ?? null,
          denials: events.filter(e => e.type === 'tool.execution_complete' && e.data?.success === false).map(e => e.data.toolName || 'unknown'),
        };
      }
      const errors = events.filter(e => /error|warning/i.test(e.type)).map(e => e.data?.message || JSON.stringify(e.data)).join('\n');
      const text = `${errors}\n${stderr}\n${events.length ? '' : stdout}`;
      if (/session limit|max-ai-credits|ai credit limit/i.test(text)) return { ok: false, code: 'BUDGET_EXCEEDED', message: firstLine(text.trim()) };
      return classifyText(text.trim() || `exit ${code}, no report`, code || 1);
    },
  },
};

function classifyText(text, exitCode) {
  const t = String(text || '');
  if (/usage limit|rate.?limit|limit reached|hit your limit|quota|too many requests|\b429\b|premium requests/i.test(t)) {
    return { ok: false, code: 'RATE_LIMITED', message: firstLine(t), retry_at: parseReset(t) };
  }
  if (/not logged in|login required|unauthori[sz]ed|authenticat|\b401\b|\b403\b/i.test(t)) {
    return { ok: false, code: 'AUTH_FAILED', message: firstLine(t) };
  }
  return { ok: false, code: 'PROVIDER_ERROR', message: firstLine(t) || `exit ${exitCode}` };
}

// "...limit reached|1730000000" (epoch seconds) is the one machine-readable
// reset format seen; anything else falls back to a fixed cooldown.
function parseReset(text) {
  const m = /\|(\d{10})\b/.exec(String(text || ''));
  return m ? Number(m[1]) * 1000 : null;
}

function firstLine(t) { return String(t).trim().split('\n').find(Boolean)?.slice(0, 300) || ''; }

// ── Adapter ──────────────────────────────────────────────────────────────────

class HarnessAdapter {
  constructor(config = {}) {
    const file = config.drivers ? null : process.env.ARK_HARNESS_CONFIG || null;
    const resolved = file ? readJson(file) || {} : config;
    this.drivers = (resolved.drivers || []).filter(d => KINDS[d.kind]).map(d => ({ limits: {}, ...d }));
    this.failover = resolved.failover !== false;
    // realpath both sides, or /var → /private/var style links fail the prefix check
    this.allowedRoots = (resolved.allowed_roots || []).map(r => safeRealpath(r) || path.resolve(r));
    this.statePath = resolved.state_path || (file ? `${file.replace(/\.json$/, '')}.state.json` : null);
    this._memState = { usage: {}, cooldowns: {} };
    this._probes = new Map();
    this._running = new Map(); // run_key -> child
    this._spawn = config._spawn || spawn; // test seam
  }

  async connect() {
    if (!this.drivers.length) return;
    console.log(`  ✓ Harness drivers: ${this.drivers.map(d => d.name).join(' → ')}`);
  }

  // Everything a caller needs to decide before running: which drivers are
  // usable right now, why not if not, and how much of each limit is left.
  async describe() {
    const state = this._readState();
    const out = [];
    for (const d of this.drivers) {
      const probe = await this._probe(d);
      const block = probe.ok ? this._limitBlock(d, state) : { code: 'HARNESS_UNAVAILABLE', message: probe.message };
      out.push({
        name: d.name,
        kind: d.kind,
        version: probe.version || null,
        available: !block,
        reason: block ? `${block.code}: ${block.message}` : null,
        capabilities: KINDS[d.kind].capabilities,
        limits: d.limits,
        usage: this._usageToday(d, state),
        cooldown_until: state.cooldowns[d.name] ? new Date(state.cooldowns[d.name]).toISOString() : null,
      });
    }
    return out;
  }

  async capabilities() {
    const drivers = await this.describe();
    return [...new Set(drivers.filter(d => d.available).flatMap(d => d.capabilities))];
  }

  isAllowedPath(p) {
    const real = safeRealpath(p);
    return !!real && this.allowedRoots.some(root => real === root || real.startsWith(root + path.sep));
  }

  // run({ run_key, prompt, cwd, required_capabilities, driver?, model?, failover? })
  // → { ok:true, driver, kind, version, report, model, cost_usd, denials, attempts }
  // throws HarnessError with .attempts on failure.
  async run(req) {
    const required = req.required_capabilities || [];
    let candidates = req.driver ? this.drivers.filter(d => d.name === req.driver) : this.drivers;
    if (req.driver && !candidates.length) throw new HarnessError('HARNESS_UNAVAILABLE', `no driver named "${req.driver}"`, { attempts: [] });
    candidates = candidates.filter(d => required.every(c => KINDS[d.kind].capabilities.includes(c)));
    if (!candidates.length) {
      throw new HarnessError('CAPABILITY_MISSING', `no configured driver offers: ${required.join(', ')}`, { attempts: [] });
    }
    const failover = (req.failover ?? true) && this.failover;
    const attempts = [];

    for (const d of candidates) {
      const started = Date.now();
      const result = await this._attempt(d, req);
      attempts.push({
        driver: d.name, kind: d.kind, version: result.version || null,
        ok: result.ok, code: result.code || null, message: result.message || null,
        duration_ms: Date.now() - started, cost_usd: result.cost_usd ?? null, requests: result.requests ?? null,
      });
      if (result.ok) return { ...result, driver: d.name, kind: d.kind, attempts };
      if (!failover || !FAILOVER_CODES.has(result.code)) break;
    }

    const last = attempts[attempts.length - 1];
    throw new HarnessError(last.code, `${last.driver}: ${last.message}`, { attempts });
  }

  cancel(runKey) {
    const child = this._running.get(runKey);
    if (!child) return false;
    child._cancelled = true;
    killTree(child);
    return true;
  }

  async _attempt(d, req) {
    const probe = await this._probe(d);
    if (!probe.ok) return { ok: false, code: 'HARNESS_UNAVAILABLE', message: probe.message };

    const block = this._limitBlock(d, this._readState());
    if (block) return { ...block, ok: false, version: probe.version };

    this._recordUsage(d, { runs: 1 });
    // The MCP config carries the run's callback token, so it goes in a
    // private file (0600) outside the agent's working dir, not on argv.
    let mcpConfigPath = null;
    if (req.mcp) {
      mcpConfigPath = path.join(os.tmpdir(), `ark-mcp-${crypto.randomBytes(8).toString('hex')}.json`);
      fs.writeFileSync(mcpConfigPath, JSON.stringify(KINDS[d.kind].mcpConfig(req.mcp)), { mode: 0o600 });
    }
    const { args, stdin } = KINDS[d.kind].build({ ...req, mcpConfigPath }, d);
    const raw = await this._exec(d, args, stdin, req).finally(() => { if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true }); });
    if (raw.cancelled) return { ok: false, code: 'CANCELLED', message: 'cancelled', version: probe.version };
    if (raw.timedOut) return { ok: false, code: 'TIMEOUT', message: `no result after ${raw.timeoutMs}ms`, version: probe.version };
    if (raw.spawnError) return { ok: false, code: 'HARNESS_UNAVAILABLE', message: raw.spawnError, version: probe.version };

    const parsed = KINDS[d.kind].parse(raw);
    if (parsed.cost_usd || parsed.requests) this._recordUsage(d, { usd: parsed.cost_usd || 0, requests: parsed.requests || 0 });
    if (parsed.code === 'RATE_LIMITED' || parsed.code === 'BUDGET_EXCEEDED') {
      this._setCooldown(d, parsed.retry_at || Date.now() + RATE_LIMIT_COOLDOWN_MS);
    } else if (parsed.code === 'AUTH_FAILED') {
      this._setCooldown(d, Date.now() + AUTH_COOLDOWN_MS);
    }
    return { ...parsed, version: probe.version };
  }

  // Pre-flight limit check. Returns null when the driver may run.
  _limitBlock(d, state) {
    const until = state.cooldowns[d.name];
    if (until && until > Date.now()) {
      return { code: 'RATE_LIMITED', message: `cooling down until ${new Date(until).toISOString()}` };
    }
    const used = this._usageToday(d, state);
    const { max_runs_per_day, max_usd_per_day, max_requests_per_day } = d.limits;
    if (max_runs_per_day != null && used.runs >= max_runs_per_day) {
      return { code: 'LIMIT_REACHED', message: `${used.runs}/${max_runs_per_day} runs in the last 24h` };
    }
    if (max_usd_per_day != null && used.usd >= max_usd_per_day) {
      return { code: 'LIMIT_REACHED', message: `$${used.usd.toFixed(2)}/$${max_usd_per_day} spent in the last 24h` };
    }
    if (max_requests_per_day != null && used.requests >= max_requests_per_day) {
      return { code: 'LIMIT_REACHED', message: `${used.requests}/${max_requests_per_day} premium requests in the last 24h` };
    }
    return null;
  }

  _usageToday(d, state) {
    const since = Date.now() - DAY_MS;
    const events = (state.usage[d.name] || []).filter(e => e.at > since);
    return {
      runs: events.reduce((n, e) => n + (e.runs || 0), 0),
      usd: Math.round(events.reduce((n, e) => n + (e.usd || 0), 0) * 10000) / 10000,
      requests: events.reduce((n, e) => n + (e.requests || 0), 0),
    };
  }

  _recordUsage(d, delta) {
    this._mutateState(state => {
      const since = Date.now() - DAY_MS;
      state.usage[d.name] = [...(state.usage[d.name] || []).filter(e => e.at > since), { at: Date.now(), ...delta }];
    });
  }

  _setCooldown(d, until) {
    this._mutateState(state => { state.cooldowns[d.name] = until; });
  }

  _readState() {
    if (!this.statePath) return this._memState;
    const s = readJson(this.statePath);
    return { usage: s?.usage || {}, cooldowns: s?.cooldowns || {} };
  }

  _mutateState(fn) {
    const state = this._readState();
    fn(state);
    if (!this.statePath) { this._memState = state; return; }
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  // `--version` must succeed — a path that exists isn't enough (VS Code ships
  // a `copilot` shim that only prints "not found").
  async _probe(d) {
    const cached = this._probes.get(d.name);
    if (cached && cached.at > Date.now() - PROBE_TTL_MS) return cached;
    const raw = await this._exec(d, ['--version'], null, { timeout_ms: 15000 });
    const text = `${raw.stdout}\n${raw.stderr}`.trim();
    const ok = !raw.spawnError && !raw.timedOut && raw.exitCode === 0 && !/not (be )?found|not installed/i.test(text);
    const probe = { at: Date.now(), ok, version: ok ? firstLine(raw.stdout) : null, message: ok ? null : (raw.spawnError || firstLine(text) || `\`${d.bin} --version\` failed`) };
    this._probes.set(d.name, probe);
    return probe;
  }

  _exec(d, args, stdin, req) {
    const timeoutMs = req.timeout_ms || d.limits.timeout_ms || DEFAULT_TIMEOUT_MS;
    const env = Object.fromEntries(ENV_ALLOWLIST.filter(k => process.env[k] != null).map(k => [k, process.env[k]]));
    return new Promise(resolve => {
      let child;
      try {
        child = this._spawn(d.bin, args, { cwd: req.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        resolve({ stdout: '', stderr: '', exitCode: null, spawnError: err.message });
        return;
      }
      if (req.run_key) this._running.set(req.run_key, child);
      let stdout = '', stderr = '', timedOut = false, done = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      child.stdout.on('data', b => { if (stdout.length < OUTPUT_CAP) stdout += b; });
      child.stderr.on('data', b => { if (stderr.length < OUTPUT_CAP) stderr += b; });
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (req.run_key) this._running.delete(req.run_key);
        resolve({ stdout, stderr, timeoutMs, timedOut, cancelled: !!child._cancelled, ...extra });
      };
      child.on('error', err => finish({ exitCode: null, spawnError: err.code === 'ENOENT' ? `${d.bin} not found on PATH` : err.message }));
      child.on('close', code => finish({ exitCode: code }));
      if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
    });
  }
}

// detached:true puts the CLI in its own process group, so a kill reaches any
// subprocesses it spawned too, not just the parent.
function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

module.exports = HarnessAdapter;
module.exports.HarnessError = HarnessError;
module.exports._internals = { KINDS, classifyText, parseReset, FAILOVER_CODES, ARK_CAPS, MCP_SERVER, MCP_TOOL };
