'use strict';

// LLMAdapter — general-purpose language model service for ARK.
// Registered in Manifest as 'llm'. Contracts declare
// `scope: { services: ['llm'] }` to receive it via service.bind.
//
// Two modes:
//   - pool (host-provided, see ark.host.js): every request goes through
//     pool.complete(task, request). The host owns model choice, fallback,
//     cooldowns and spending policy; passing `model` pins that model.
//   - direct (no pool): one OpenRouter call to `model`.
//
// Config (all optional — falls back to env):
//   apiKey       : process.env.OPENROUTER_API_KEY
//   model        : process.env.OPENROUTER_MODEL, then defaultModel
//   defaultModel : the host's default when env sets none (default: anthropic/claude-3.5-sonnet)
//   fallback     : process.env.OPENROUTER_FALLBACK_MODEL
//   pool, task   : pool instance and its task id (default: 'ark.llm')
//   baseUrl      : process.env.OPENROUTER_BASE_URL (direct mode; default: openrouter.ai)
//   timeout      : ms (direct mode; default: 60_000)

const axios = require('axios');
const usage = require('../utils/usage');
const { validate } = require('../utils/schema');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL    = 'anthropic/claude-3.5-sonnet';
const DEFAULT_TASK     = 'ark.llm';
// Host pool refusals (spending policy) pass through untouched — they are a
// decision, not a transport failure.
const POLICY_CODES     = new Set(['MODEL_NOT_FREE', 'MODEL_NOT_IN_CATALOG']);

class LLMAdapter {
  constructor(config = {}) {
    this.apiKey   = config.apiKey   || process.env.OPENROUTER_API_KEY   || null;
    this.baseUrl  = config.baseUrl  || process.env.OPENROUTER_BASE_URL  || DEFAULT_BASE_URL;
    this.model    = config.model    || process.env.OPENROUTER_MODEL      || config.defaultModel || DEFAULT_MODEL;
    this.fallback = config.fallback || process.env.OPENROUTER_FALLBACK_MODEL || null;
    this.timeout  = config.timeout  || 60_000;
    this.task     = config.task     || DEFAULT_TASK;
    this.pool     = config.pool     || null;
    if (this.pool) this.pool.defineTask(this.task, { models: [this.model, this.fallback] });
  }

  async connect() {
    if (!this.apiKey) {
      console.warn('  ⚠  LLM adapter: OPENROUTER_API_KEY not set — AI features disabled');
      return;
    }
    console.log(`  ✓ LLM adapter ready (${this.model})`);
  }

  // status() — live connectivity check. Call explicitly (health endpoint, diagnostics).
  // Never called automatically — startup stays fast.
  // Returns: { ok, model, latency_ms, error? }
  async status() {
    if (!this.apiKey) {
      return { ok: false, model: this.model, error: 'OPENROUTER_API_KEY not set' };
    }
    const start = Date.now();
    try {
      await this.complete({
        model:      this.model,
        messages:   [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      });
      return { ok: true, model: this.model, latency_ms: Date.now() - start };
    } catch (err) {
      return { ok: false, model: this.model, latency_ms: Date.now() - start, error: err.message };
    }
  }

  // complete({ messages, model?, temperature?, max_tokens?, response_format? })
  //
  // messages       : OpenAI-style [{ role, content }]
  // model          : this call's model. With a pool it pins that model (no
  //                  fallback); omitted, the pool chooses.
  // temperature    : 0–1 (default 0.3 — lower for structured ARK output)
  // max_tokens     : (default 4096)
  // response_format: { type: 'json_object' } for structured output
  //
  // Returns: { content, model_used, tokens_used, prompt_tokens, completion_tokens,
  //            finish_reason, cost, attempt }
  // Throws on failure (caller handles; ledger records the failure stage).
  // Every call that reaches a model is metered (utils/usage.js) into the
  // calling action's ledger row, failed or not.
  async complete({
    messages,
    model,
    temperature = 0.3,
    max_tokens  = 4096,
    response_format,
  } = {}) {
    if (!this.apiKey) {
      throw Object.assign(new Error('LLM service not configured — OPENROUTER_API_KEY missing'), {
        code: 'LLM_NOT_CONFIGURED',
        status: 503,
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      throw Object.assign(new Error('messages must be a non-empty array'), {
        code: 'LLM_INVALID_MESSAGES',
        status: 400,
      });
    }

    if (this.pool) return this._viaPool({ messages, model, temperature, max_tokens, response_format });

    model = model || this.model;
    // usage.include: OpenRouter reports the call's actual cost.
    const body = { model, messages, temperature, max_tokens, usage: { include: true } };
    if (response_format) body.response_format = response_format;

    const started = Date.now();
    const attempt = (ok, extra = {}) => usage.record({
      kind: 'llm', provider: 'openrouter', model, ok, code: null,
      duration_ms: Date.now() - started, tokens: null, cost: usage.cost({ model }), ...extra,
    });

    let response;
    try {
      response = await this._post(body);
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      const status = err.response?.status || 502;
      attempt(false, { code: 'LLM_REQUEST_FAILED' });
      throw Object.assign(new Error(`LLM request failed: ${msg}`), {
        code: 'LLM_REQUEST_FAILED',
        status,
        upstream: msg,
      });
    }

    const choice = response.data?.choices?.[0];
    const used = response.data?.model || model;
    const u = response.data?.usage || {};
    const metered = {
      model: used,
      tokens: { prompt: u.prompt_tokens ?? null, completion: u.completion_tokens ?? null },
      cost: usage.cost({ usd: u.cost, model }),
    };
    if (!choice?.message) {
      attempt(false, { ...metered, code: 'LLM_BAD_RESPONSE' });
      throw Object.assign(new Error('LLM returned unexpected response shape'), {
        code: 'LLM_BAD_RESPONSE',
        status: 502,
      });
    }

    let content = choice.message.content;
    // Some providers return content as an array of blocks
    if (Array.isArray(content)) {
      content = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n') || null;
    }
    if (!content) {
      attempt(false, { ...metered, code: 'LLM_EMPTY_CONTENT' });
      throw Object.assign(new Error('LLM returned empty content'), {
        code: 'LLM_EMPTY_CONTENT',
        status: 502,
      });
    }

    const a = attempt(true, metered);
    return {
      content,
      model_used:        used,
      tokens_used:       u.total_tokens   || null,
      prompt_tokens:     u.prompt_tokens  || null,
      completion_tokens: u.completion_tokens || null,
      finish_reason:     choice.finish_reason || null,
      cost:              a.cost,
      attempt:           a,
    };
  }

  _post(body) {
    return axios.post(this.baseUrl, body, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://seravanna.com',
        'X-Title':       'ARK Engine',
      },
      timeout: this.timeout,
    });
  }

  // The host pool owns model choice and fallback. A failed request reports
  // each model it tried (err.failures); a success reports the model that
  // answered and how many it took (attempts) — the pool doesn't return the
  // earlier failures, so only their count is kept.
  async _viaPool({ response_format, ...request }) {
    if (response_format) request.response_format = response_format;
    const started = Date.now();
    let result;
    try {
      result = await this.pool.complete(this.task, request);
    } catch (err) {
      const failures = Array.isArray(err.failures) && err.failures.length
        ? err.failures
        : [{ model: request.model || null, code: err.code || 'LLM_REQUEST_FAILED' }];
      for (const f of failures) {
        usage.record({
          kind: 'llm', provider: 'pool', model: f.model || null, ok: false, code: f.code || null,
          duration_ms: failures.length === 1 ? Date.now() - started : null, tokens: null, cost: usage.cost({ model: f.model }),
        });
      }
      if (POLICY_CODES.has(err.code)) throw err;
      throw Object.assign(new Error(`LLM request failed: ${err.message}`), {
        code: 'LLM_REQUEST_FAILED',
        status: err.status || 502,
        upstream: err.code,
        failures: err.failures,
      });
    }
    const local = result.selection_reason === 'local';
    const completion = result.completion_tokens
      ?? (result.tokens_used != null && result.prompt_tokens != null ? result.tokens_used - result.prompt_tokens : null);
    const a = usage.record({
      kind: 'llm', provider: local ? 'local' : 'pool', model: result.model_used || null, ok: true, code: null,
      duration_ms: Date.now() - started,
      tokens: { prompt: result.prompt_tokens ?? null, completion },
      // Local compute is free; otherwise only what the pool reports.
      cost: usage.cost({ usd: result.cost_usd, model: result.requested_model || result.model_used, free: local }),
      ...(result.attempts > 1 ? { pool_attempts: result.attempts } : {}),
    });
    return {
      content:           result.content,
      model_used:        result.model_used,
      tokens_used:       result.tokens_used,
      prompt_tokens:     result.prompt_tokens,
      completion_tokens: completion,
      finish_reason:     result.finish_reason,
      cost:              a.cost,
      attempt:           a,
    };
  }

  // completeJSON({ ...complete opts, schema?, json_mode = true })
  //
  // Parses the reply (a ```json fence is tolerated) and, given a schema
  // (utils/schema.js), validates it. A reply that isn't the promised shape
  // is a failure the caller sees — LLM_INVALID_JSON / LLM_INVALID_OUTPUT —
  // never a silently defaulted value; the attempt records why.
  // json_mode: false skips response_format for models that don't support it.
  async completeJSON({ schema, json_mode = true, ...opts } = {}) {
    const result = await this.complete({ ...opts, ...(json_mode ? { response_format: { type: 'json_object' } } : {}) });
    const check = { schema: schema?.name || (schema ? 'inline' : 'json') };
    const reject = (code, message, errors) => {
      if (result.attempt) result.attempt.validation = { ...check, ok: false, errors };
      throw Object.assign(new Error(message), { code, status: 502, errors, raw: String(result.content).slice(0, 2000) });
    };

    let parsed;
    try {
      parsed = JSON.parse(String(result.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch {
      reject('LLM_INVALID_JSON', 'LLM returned invalid JSON', ['$: not valid JSON']);
    }
    const errors = schema ? validate(schema, parsed) : [];
    if (errors.length) reject('LLM_INVALID_OUTPUT', `LLM reply does not match ${check.schema}: ${errors[0]}`, errors);

    if (result.attempt) result.attempt.validation = { ...check, ok: true };
    result.parsed = parsed;
    return result;
  }
}

module.exports = LLMAdapter;
module.exports._internals = { DEFAULT_MODEL, DEFAULT_BASE_URL, DEFAULT_TASK };
