'use strict';

// Model usage, metered per dispatch. dispatch() opens a meter around each
// action; every model call made while it runs (an LLM completion, an agent
// attempt) records one attempt into it; the action's ledger row stores the
// summary. Nested dispatches (chain hooks, agent callbacks) get their own
// meter, so each ledger row carries only what its own action consumed.
//
// One attempt shape for every kind of model call:
//   { kind: 'llm'|'agent', provider, model, ok, code, duration_ms,
//     tokens: { prompt, completion } | null,
//     cost: { usd, basis: 'reported'|'free'|'unknown', requests? },
//     validation?: { schema, ok, errors? } }
//
// cost.basis says where the number came from. 'unknown' is never shown as
// $0: totals count it separately.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const KEPT = 50; // attempts stored per ledger row; totals always cover all of them

function run(fn) {
  const meter = { attempts: [] };
  return als.run(meter, () => fn(meter));
}

// Records into the current meter, if any (a call outside dispatch — a
// script, a test — is simply not metered). Returns the attempt, which the
// caller may still annotate (validation) before the ledger closes.
function record(attempt) {
  const meter = als.getStore();
  if (meter) meter.attempts.push(attempt);
  return attempt;
}

function cost({ usd = null, model = null, free = false, requests = null } = {}) {
  const extra = requests != null ? { requests } : {};
  if (typeof usd === 'number' && Number.isFinite(usd)) return { usd, basis: 'reported', ...extra };
  if (free || (typeof model === 'string' && model.endsWith(':free'))) return { usd: 0, basis: 'free', ...extra };
  return { usd: null, basis: 'unknown', ...extra };
}

function summarize(attempts) {
  if (!attempts.length) return null;
  const totals = { calls: attempts.length, failed: 0, invalid: 0, prompt_tokens: 0, completion_tokens: 0, usd_reported: 0, unpriced: 0, requests: 0 };
  for (const a of attempts) {
    if (!a.ok) totals.failed++;
    if (a.validation && !a.validation.ok) totals.invalid++;
    totals.prompt_tokens     += a.tokens?.prompt     || 0;
    totals.completion_tokens += a.tokens?.completion || 0;
    totals.requests          += a.cost?.requests     || 0;
    if (a.cost?.basis === 'reported') totals.usd_reported += a.cost.usd;
    else if (a.cost?.basis !== 'free') totals.unpriced++;
  }
  totals.usd_reported = Math.round(totals.usd_reported * 1e6) / 1e6;
  return {
    totals,
    attempts: attempts.slice(0, KEPT),
    ...(attempts.length > KEPT ? { truncated: attempts.length - KEPT } : {}),
  };
}

// A harness attempt (adapters/harness.js) in the shared shape.
function fromHarness(a, model = null) {
  return {
    kind: 'agent', provider: a.driver, model: a.ok ? model : null, ok: a.ok, code: a.code || null,
    duration_ms: a.duration_ms ?? null, tokens: null,
    cost: cost({ usd: a.cost_usd, requests: a.requests }),
  };
}

module.exports = { run, record, cost, summarize, fromHarness, KEPT };
