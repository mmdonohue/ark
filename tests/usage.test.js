'use strict';

// Model usage and reply validation: every model call an action makes (LLM
// completion or agent attempt) is metered onto that action's ledger row in
// one shape, and a structured reply that isn't the promised shape fails
// visibly instead of being defaulted.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const usage = require('../utils/usage');
const { validate } = require('../utils/schema');
const LLMAdapter = require('../adapters/llm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-usage-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// An OpenRouter-shaped reply.
const reply = (content, { model = 'vendor/model', cost, prompt = 12, completion = 4 } = {}) => ({
  data: { model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, ...(cost != null ? { cost } : {}) } },
});
const direct = (post, extra = {}) => Object.assign(new LLMAdapter({ apiKey: 'k', model: 'vendor/model', ...extra }), { _post: post });
const metered = fn => usage.run(async m => { let err = null; try { await fn(); } catch (e) { err = e; } return { attempts: m.attempts, err }; });

// ── the contract ────────────────────────────────────────────────────────────

test('schema.validate: the subset callers rely on', () => {
  const s = { type: 'object', required: ['a', 'n'], additionalProperties: false, properties: {
    a: { type: 'string', enum: ['x', 'y'] }, n: { type: 'number', minimum: 0, maximum: 1 }, list: { type: 'array', items: { type: 'integer' } }, s: { type: 'string', minLength: 1, maxLength: 3 },
  } };
  assert.deepEqual(validate(s, { a: 'x', n: 0.5, list: [1, 2], s: 'ab' }), []);
  assert.deepEqual(validate(s, { a: 'z', n: 2, list: [1, 'b'], s: '', extra: 1 }), [
    '$.a: must be one of "x", "y"', '$.n: must be ≤ 1', '$.list[1]: expected integer, got string', '$.s: must be at least 1 characters', '$: unexpected "extra"',
  ]);
  assert.deepEqual(validate(s, { a: 'x' }), ['$: missing "n"']);
  assert.deepEqual(validate(s, 'nope'), ['$: expected object, got string']);
  assert.deepEqual(validate({ type: 'number' }, 3), [], 'an integer is a number');
});

test('usage.cost: reported beats everything; :free and local are free; otherwise unknown, never $0', () => {
  assert.deepEqual(usage.cost({ usd: 0.0021, model: 'm:free' }), { usd: 0.0021, basis: 'reported' });
  assert.deepEqual(usage.cost({ model: 'vendor/m:free' }), { usd: 0, basis: 'free' });
  assert.deepEqual(usage.cost({ free: true }), { usd: 0, basis: 'free' });
  assert.deepEqual(usage.cost({ model: 'vendor/m' }), { usd: null, basis: 'unknown' });
  assert.deepEqual(usage.cost({ requests: 2 }), { usd: null, basis: 'unknown', requests: 2 });
});

test('usage.summarize: totals separate reported dollars from unpriced calls; long lists are capped, totals are not', () => {
  assert.equal(usage.summarize([]), null);
  const a = (o) => ({ kind: 'llm', ok: true, tokens: { prompt: 10, completion: 5 }, cost: usage.cost({}), ...o });
  const s = usage.summarize([
    a({ cost: usage.cost({ usd: 0.25 }) }), a({ cost: usage.cost({ usd: 0.5 }) }), a({ cost: usage.cost({ free: true }) }),
    a({ ok: false, tokens: null }), a({ validation: { schema: 's', ok: false } }), a({ kind: 'agent', tokens: null, cost: usage.cost({ requests: 3 }) }),
  ]);
  assert.deepEqual(s.totals, { calls: 6, failed: 1, invalid: 1, prompt_tokens: 40, completion_tokens: 20, usd_reported: 0.75, unpriced: 3, requests: 3 });
  const many = usage.summarize(Array.from({ length: usage.KEPT + 7 }, () => a({})));
  assert.equal(many.attempts.length, usage.KEPT);
  assert.equal(many.truncated, 7);
  assert.equal(many.totals.calls, usage.KEPT + 7);
});

test('usage.record: outside a meter nothing is kept; nested meters are separate', async () => {
  usage.record({ ok: true }); // no throw
  const outer = await usage.run(async m => {
    usage.record({ n: 1 });
    const inner = await usage.run(async m2 => { usage.record({ n: 2 }); return m2.attempts; });
    assert.deepEqual(inner, [{ n: 2 }]);
    return m.attempts;
  });
  assert.deepEqual(outer, [{ n: 1 }]);
});

// ── the LLM adapter ─────────────────────────────────────────────────────────

test('llm direct: asks OpenRouter for the cost and meters every call, failed or not', async () => {
  let body;
  const ok = await metered(() => direct(async b => { body = b; return reply('hi', { cost: 0.0042 }); }).complete({ messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual(body.usage, { include: true });
  assert.equal(ok.attempts.length, 1);
  const [a] = ok.attempts;
  assert.deepEqual({ kind: a.kind, provider: a.provider, model: a.model, ok: a.ok, tokens: a.tokens, cost: a.cost },
    { kind: 'llm', provider: 'openrouter', model: 'vendor/model', ok: true, tokens: { prompt: 12, completion: 4 }, cost: { usd: 0.0042, basis: 'reported' } });
  assert.equal(typeof a.duration_ms, 'number');

  const free = await metered(() => direct(async () => reply('hi', { model: 'vendor/model' })).complete({ model: 'vendor/model:free', messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual(free.attempts[0].cost, { usd: 0, basis: 'free' }, 'a :free model is free even when the reply drops the suffix');

  const down = await metered(() => direct(async () => { throw Object.assign(new Error('boom'), { response: { status: 503, data: { error: { message: 'upstream down' } } } }); }).complete({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(down.err.code, 'LLM_REQUEST_FAILED');
  assert.deepEqual({ ok: down.attempts[0].ok, code: down.attempts[0].code, cost: down.attempts[0].cost }, { ok: false, code: 'LLM_REQUEST_FAILED', cost: { usd: null, basis: 'unknown' } });

  const empty = await metered(() => direct(async () => reply('')).complete({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(empty.err.code, 'LLM_EMPTY_CONTENT');
  assert.deepEqual(empty.attempts[0].tokens, { prompt: 12, completion: 4 }, 'tokens spent on an empty reply still count');

  const unconfigured = await metered(() => new LLMAdapter({ apiKey: null }).complete({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(unconfigured.err.code, 'LLM_NOT_CONFIGURED');
  assert.equal(unconfigured.attempts.length, 0, 'no model was called');
});

test('llm pool: the answering model, local = free, and each failed model when the pool gives up', async () => {
  const pool = (complete) => ({ defineTask() {}, complete });
  const msg = { messages: [{ role: 'user', content: 'x' }] };

  const local = await metered(() => direct(null, { pool: pool(async () => ({ content: 'ok', model_used: 'nemotron', requested_model: 'nemotron', prompt_tokens: 10, tokens_used: 15, selection_reason: 'local', attempts: 2 })) }).complete(msg));
  const [a] = local.attempts;
  assert.deepEqual({ provider: a.provider, model: a.model, tokens: a.tokens, cost: a.cost, pool_attempts: a.pool_attempts },
    { provider: 'local', model: 'nemotron', tokens: { prompt: 10, completion: 5 }, cost: { usd: 0, basis: 'free' }, pool_attempts: 2 });

  const remote = await metered(() => direct(null, { pool: pool(async () => ({ content: 'ok', model_used: 'vendor/m', requested_model: 'vendor/m:free', selection_reason: 'configured#0', attempts: 1 })) }).complete(msg));
  assert.deepEqual(remote.attempts[0].cost, { usd: 0, basis: 'free' });

  const allFailed = await metered(() => direct(null, { pool: pool(async () => { throw Object.assign(new Error('all failed'), { code: 'LLM_ALL_FAILED', failures: [{ model: 'a:free', code: 'RATE_LIMITED' }, { model: 'b', code: 'TRANSIENT' }] }); }) }).complete(msg));
  assert.equal(allFailed.err.code, 'LLM_REQUEST_FAILED');
  assert.deepEqual(allFailed.attempts.map(x => [x.provider, x.model, x.ok, x.code]), [['pool', 'a:free', false, 'RATE_LIMITED'], ['pool', 'b', false, 'TRANSIENT']]);
});

test('llm completeJSON: validates against the schema; off-contract replies fail and say why', async () => {
  const schema = { name: 'pick', type: 'object', required: ['pick'], properties: { pick: { type: 'string', enum: ['a', 'b'] } } };
  const call = (content, opts = {}) => metered(async () => direct(async () => reply(content)).completeJSON({ messages: [{ role: 'user', content: 'x' }], schema, ...opts }));

  const ok = await usage.run(async m => {
    const r = await direct(async () => reply('```json\n{"pick":"a"}\n```')).completeJSON({ messages: [{ role: 'user', content: 'x' }], schema });
    return { r, m };
  });
  assert.deepEqual(ok.r.parsed, { pick: 'a' }, 'a json fence is tolerated');
  assert.deepEqual(ok.m.attempts[0].validation, { schema: 'pick', ok: true });

  const wrong = await call('{"pick":"c"}');
  assert.equal(wrong.err.code, 'LLM_INVALID_OUTPUT');
  assert.deepEqual(wrong.err.errors, ['$.pick: must be one of "a", "b"']);
  assert.equal(wrong.err.raw, '{"pick":"c"}');
  assert.deepEqual(wrong.attempts[0].validation, { schema: 'pick', ok: false, errors: ['$.pick: must be one of "a", "b"'] });
  assert.equal(wrong.attempts[0].ok, true, 'the call itself succeeded; the reply failed its contract');

  const prose = await call('Sure! The answer is a.');
  assert.equal(prose.err.code, 'LLM_INVALID_JSON');
  assert.equal(prose.attempts[0].validation.ok, false);

  let body;
  await metered(() => direct(async b => { body = b; return reply('{"pick":"b"}'); }).completeJSON({ messages: [{ role: 'user', content: 'x' }], schema, json_mode: false }));
  assert.equal(body.response_format, undefined, 'json_mode:false leaves response_format off');
  await metered(() => direct(async b => { body = b; return reply('{"pick":"b"}'); }).completeJSON({ messages: [{ role: 'user', content: 'x' }] }));
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

// ── through dispatch(): the ledger row carries it ───────────────────────────

const { bootstrap, _reset, getManifest } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const run = (action, payload = {}) => dispatch({ action, payload }, ADMIN);

async function ledgerRow(id) {
  for (let i = 0; i < 50; i++) {
    const row = (await run('ledger.get', { ledger_id: id })).data;
    const r = row.ledger;
    if (r.status && r.status !== 'open') return r;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error(`ledger ${id} never closed`);
}
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
// A failed dispatch doesn't return its ledger id; find its row.
async function lastError(action) {
  for (let i = 0; i < 50; i++) {
    const [row] = (await run('ledger.list', { action, status: 'error', limit: 1 })).data.ledger;
    if (row) return ledgerRow(row.id);
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error(`no error row for ${action}`);
}

function fakeCli(name, body) {
  const file = path.join(TMP, `${name}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    `if (process.argv.includes('--version')) { console.log('${name} 1.0.0'); process.exit(0); }`,
    'let input = ""; process.stdin.on("data", d => input += d); process.stdin.on("end", () => {', body, '});',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  return file;
}
const rateLimited = fakeCli('claude', `
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Claude AI usage limit reached' }));
  process.exit(1);
`);
const copilotOk = fakeCli('copilot', `
  const ev = (type, data) => console.log(JSON.stringify({ type, data }));
  ev('session.tools_updated', { model: 'claude-sonnet-5.5' });
  ev('assistant.message', { content: 'copilot report' });
  console.log(JSON.stringify({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } }));
`);

before(async () => {
  _reset();
  await bootstrap({
    db: { driver: 'sqlite', path: path.join(TMP, 'usage.sqlite') },
    harness: { drivers: [{ name: 'claude', kind: 'claude-code', bin: rateLimited }, { name: 'copilot', kind: 'copilot', bin: copilotOk }], allowed_roots: [TMP] },
  });
});

test('media.classify.vision: usage and validation land on the action\'s ledger row', async () => {
  const llm = getManifest().get('llm');
  const saved = { apiKey: llm.apiKey, pool: llm.pool, _post: llm._post };
  const photo = path.join(TMP, 'bird.jpg');
  fs.writeFileSync(photo, 'not really a jpeg');
  let next;
  Object.assign(llm, { apiKey: 'k', pool: null, _post: async () => reply(next, { cost: 0.001 }) });
  try {
    next = '{"likely_subject":"birds","confidence":0.92}';
    const ok = await run('media.classify.vision', { source_path: photo, candidate_subjects: ['birds', 'yard'] });
    assert.deepEqual({ s: ok.data.likely_subject, c: ok.data.confidence }, { s: 'birds', c: 0.92 });
    const row = await ledgerRow(ok.meta.ledger_id);
    const u = json(row.usage);
    assert.equal(u.totals.calls, 1);
    assert.equal(u.totals.usd_reported, 0.001);
    assert.deepEqual(u.attempts[0].validation, { schema: 'classify.vision', ok: true });

    // Off-vocabulary: used to pass through (or be defaulted to "unknown"); now a visible failure.
    next = '{"likely_subject":"bird","confidence":0.9}';
    const err = await run('media.classify.vision', { source_path: photo, candidate_subjects: ['birds', 'yard'] }).catch(e => e);
    assert.equal(err.code, 'LLM_INVALID_OUTPUT');
    const errRow = await lastError('media.classify.vision');
    assert.equal(errRow.status, 'error');
    assert.equal(json(errRow.usage).totals.invalid, 1, 'a failed action still records what it spent');

    // In a batch the photo is routed like an unknown, marked, and not persisted.
    next = 'I think this is a bird.';
    const batch = await run('media.classify_batch', { files: [{ basename: 'bird.jpg', source_path: photo, ext: 'jpg', needs_classification: true }], candidate_subjects: ['birds'] });
    const [f] = batch.data.files;
    assert.deepEqual({ s: f.likely_subject, c: f.confidence, e: f.classification_error }, { s: 'unknown', c: 0, e: 'LLM_INVALID_JSON' });
    assert.equal(json((await ledgerRow(batch.meta.ledger_id)).usage).totals.invalid, 1);
  } finally {
    Object.assign(llm, saved);
  }
});

test('harness.run: each agent attempt, failover included, lands on the run\'s ledger row', async () => {
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(repo);
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
  g('add', '.');
  g('commit', '-qm', 'init');

  const task = (await run('task.propose', { title: 'Review', inputs: { repositories: [{ alias: 'r', path: repo }] }, required_capabilities: ['repo.read'] })).data.task;
  await run('task.approve', { task_id: task.id });
  const r = await run('harness.run', { task_id: task.id });
  const u = json((await ledgerRow(r.meta.ledger_id)).usage);
  assert.deepEqual(u.attempts.map(a => [a.kind, a.provider, a.ok, a.code, a.cost.basis]), [
    ['agent', 'claude', false, u.attempts[0].code, 'unknown'],
    ['agent', 'copilot', true, null, 'unknown'],
  ]);
  assert.equal(u.attempts[1].cost.requests, 1, 'copilot reports premium requests, not dollars');
  assert.equal(u.attempts[1].model, r.data.review.metadata.model ?? null);
  assert.deepEqual({ calls: u.totals.calls, failed: u.totals.failed, unpriced: u.totals.unpriced, requests: u.totals.requests }, { calls: 2, failed: 1, unpriced: 2, requests: 1 });
});

test('sqlite: a vessel whose ledger predates the usage column gets it on open', async () => {
  const Database = require('better-sqlite3');
  const SqliteAdapter = require('../adapters/sqlite');
  const file = path.join(TMP, 'old.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE artifact_ledger (id TEXT PRIMARY KEY, store_id INTEGER, status TEXT)');
  db.close();
  const a = new SqliteAdapter(file);
  await a.connect();
  assert.ok(a.db.prepare('PRAGMA table_info(artifact_ledger)').all().some(c => c.name === 'usage'));
  a.db.close();
});

after(() => _reset());
