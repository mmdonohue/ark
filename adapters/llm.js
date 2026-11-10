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
  // Returns: { content, model_used, tokens_used, prompt_tokens, finish_reason }
  // Throws on failure (caller handles; ledger records the failure stage).
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
    const body = { model, messages, temperature, max_tokens };
    if (response_format) body.response_format = response_format;

    let response;
    try {
      response = await axios.post(this.baseUrl, body, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://seravanna.com',
          'X-Title':       'ARK Engine',
        },
        timeout: this.timeout,
      });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      const status = err.response?.status || 502;
      throw Object.assign(new Error(`LLM request failed: ${msg}`), {
        code: 'LLM_REQUEST_FAILED',
        status,
        upstream: msg,
      });
    }

    const choice = response.data?.choices?.[0];
    if (!choice?.message) {
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
      throw Object.assign(new Error('LLM returned empty content'), {
        code: 'LLM_EMPTY_CONTENT',
        status: 502,
      });
    }

    return {
      content,
      model_used:    response.data.model || model,
      tokens_used:   response.data.usage?.total_tokens   || null,
      prompt_tokens: response.data.usage?.prompt_tokens  || null,
      finish_reason: choice.finish_reason || null,
    };
  }

  async _viaPool({ response_format, ...request }) {
    if (response_format) request.response_format = response_format;
    let result;
    try {
      result = await this.pool.complete(this.task, request);
    } catch (err) {
      if (POLICY_CODES.has(err.code)) throw err;
      throw Object.assign(new Error(`LLM request failed: ${err.message}`), {
        code: 'LLM_REQUEST_FAILED',
        status: err.status || 502,
        upstream: err.code,
        failures: err.failures,
      });
    }
    return {
      content:       result.content,
      model_used:    result.model_used,
      tokens_used:   result.tokens_used,
      prompt_tokens: result.prompt_tokens,
      finish_reason: result.finish_reason,
    };
  }

  // completeJSON — convenience wrapper that requests json_object format
  // and parses the result. Throws if the response isn't valid JSON.
  async completeJSON(opts = {}) {
    const result = await this.complete({ ...opts, response_format: { type: 'json_object' } });
    try {
      result.parsed = JSON.parse(result.content);
    } catch {
      throw Object.assign(new Error('LLM returned invalid JSON'), {
        code:     'LLM_INVALID_JSON',
        status:   502,
        raw:      result.content,
      });
    }
    return result;
  }
}

module.exports = LLMAdapter;
module.exports._internals = { DEFAULT_MODEL, DEFAULT_BASE_URL, DEFAULT_TASK };
