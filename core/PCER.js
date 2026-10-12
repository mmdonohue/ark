'use strict';

const crypto = require('crypto');

// PCER — Pre-Contract Execution Resolver.
//
// Transforms a Canonical Packet into a contract-specific Execution Packet
// before any business logic runs. Contracts never execute against the
// Canonical Packet directly.
//
// Pipeline:
//   DEFAULT_TRACE (trace.open, auth.verify, scope.resolve)
//   + contract.execution_trace (contract-specific stages)
//   → each trace contract executes in order, each with its own scope
//   → result is handled by response.type:
//       'merge'       — declared payload keys folded into the ExecutionPacket
//       'gate'        — executes, aborts pipeline on throw, contributes nothing
//       'void'        — executes, contributes nothing (side effects only)
//       'side_effect' — executes, contributes nothing to ep; produced keys are
//                       recorded in the trace for audit (the effect happened
//                       externally — an artifact created, a file written)
//       'observe'     — executes, contributes nothing to ep; the observation
//                       itself is preserved in the trace for provenance but
//                       never rewrites canonical intent or resolution
//
//   'validate', 'trace', 'replace' remain unimplemented — add only when a
//   concrete stage needs semantics 'merge'/'gate'/'void'/'side_effect'/'observe'
//   cannot already express (charter §8: do not invent categories speculatively).
//
// The assembled ExecutionPacket is the only object visible to contract handlers.

// ── Default trace contracts ───────────────────────────────────────────────────
//
// These run for every contract in this order. Contracts may not remove them
// but may add their own stages after them via execution_trace.

const DEFAULT_TRACE = [
  {
    action:   'trace.open',
    response: { type: 'void' },
    required: true,
    scope:    { identity: 'actor', request: 'current' },
  },
  {
    action:   'auth.verify',
    response: { type: 'gate' },
    required: true,
    scope:    { identity: 'actor', tenant: 'current', role: 'current' },
  },
  {
    action:   'ledger.open',
    response: { type: 'merge', payload: ['ledger_id'] },
    required: false,   // no-op without DB (tests); production always registers it
    scope:    { identity: 'actor', tenant: 'current', request: 'current' },
  },
  {
    action:   'scope.resolve',
    response: { type: 'merge', payload: ['scope', 'capabilities'] },
    required: false,
    scope:    { tenant: 'current', identity: 'actor', role: 'current' },
  },
  {
    action:   'payload.project',
    response: { type: 'merge', payload: ['payload'] },
    required: false,   // no-op when contract has no fields declared
    scope:    {},
  },
  {
    action:   'service.bind',
    response: { type: 'merge', payload: ['services'] },
    required: false,   // no-op when contract declares no services
    scope:    {},
  },
];

class PCER {

  // resolve — main entry point.
  //
  // canonicalPacket : the immutable inbound packet (action, payload, meta, _objects)
  // contract        : resolved contract from TemplateResolver (or null for untemplatted actions)
  // ctx             : actor context (user_id, store_id, request_id, …)
  // registry        : PCER_REGISTRY — trace contract handlers
  //
  // Returns an ExecutionPacket.
  // Throws if a required trace contract fails.
  static async resolve({ canonicalPacket, contract, ctx, registry }) {
    const ep = _emptyExecutionPacket(canonicalPacket, contract, ctx);

    const traceContracts = _buildTraceList(contract);

    for (const stage of traceContracts) {
      const handler = registry[stage.action];

      if (!handler) {
        if (stage.required) {
          throw Object.assign(
            new Error(`Required trace contract not registered: ${stage.action}`),
            { code: 'PCER_MISSING_TRACE' },
          );
        }
        ep.trace.steps.push({ action: stage.action, status: 'skipped' });
        continue;
      }

      // Each trace contract receives only the canonical packet + its declared
      // scope, not the growing execution packet — it can't see what earlier
      // stages resolved.
      const stageCtx = _projectScope(stage.scope, ctx, canonicalPacket);

      let result;
      try {
        result = await handler(stageCtx, canonicalPacket, ep);
      } catch (err) {
        ep.trace.steps.push({ action: stage.action, status: 'failed', error: err.message });
        throw Object.assign(err, { pcer_stage: stage.action });
      }

      const type = stage.response?.type || 'void';

      if (type === 'merge') {
        const keys     = stage.response?.payload || [];
        const strategy = stage.response?.merge_strategy || 'assign';
        const shaped   = keys.length ? _pick(result, keys) : result;
        _applyMerge(ep, shaped, strategy);
        ep.trace.steps.push({ action: stage.action, status: 'ok', type: 'merge', merged: Object.keys(shaped) });

      } else if (type === 'gate') {
        // handler threw above if failing — reaching here means it passed
        ep.trace.steps.push({ action: stage.action, status: 'ok', type: 'gate' });

      } else if (type === 'side_effect') {
        // executes, contributes nothing to ep — the effect happened externally.
        // Record which keys the handler produced for audit, without merging them.
        const produced = result?.data ? Object.keys(result.data) : [];
        ep.trace.steps.push({ action: stage.action, status: 'ok', type: 'side_effect', produced });

      } else if (type === 'observe') {
        // executes, contributes nothing to ep — pure assessment/perspective.
        // Preserved in the trace for provenance; never feeds back into resolution.
        ep.trace.steps.push({ action: stage.action, status: 'ok', type: 'observe', observed: result?.data ?? null });

      } else {
        // void
        ep.trace.steps.push({ action: stage.action, status: 'ok', type: 'void' });
      }
    }

    ep.provenance.resolved_at = new Date().toISOString();
    return ep;
  }

  // snapshot — returns the current default trace list for inspection/testing
  static get defaultTrace() { return DEFAULT_TRACE.map(s => ({ ...s })); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _emptyExecutionPacket(canonicalPacket, contract, ctx) {
  return {
    // ── Flat ctx fields — backward-compatible with existing handler signature
    // (ctx, payload, packet). Handlers access ep.user_id, ep.store_id etc.
    // exactly as they did before. New code uses ep.scope / ep.capabilities.
    user_id:    ctx.user_id    || null,
    store_id:   ctx.store_id   || null,
    site_id:    ctx.site_id    || null,
    request_id: ctx.request_id || null,
    ip:         ctx.ip         || null,
    user_agent: ctx.user_agent || null,
    source:     ctx.source     || 'system',
    role:         ctx.role         || null,
    role_id:      ctx.role_id      || null,
    rank:         ctx.rank         ?? null,
    ark_actor_id: ctx.ark_actor_id || null, // ARK-native actor identity — local-only actors have this, not user_id

    // ── PCER identity
    packet_id:    canonicalPacket.meta?.request_id || null,
    contract:     contract?.slug || contract?.id   || canonicalPacket.action || null,
    contract_def: contract || null,   // full resolved contract — read by payload.project, service.bind
    action:       canonicalPacket.action,

    // ── Resolved by trace contracts
    // scope.requested: what the contract declared it needs
    // scope.granted:   what policy resolved (Phase 8 narrows this)
    // scope.denied:    what was narrowed out
    scope:        { requested: {}, granted: {}, denied: {} },
    capabilities: [],
    context:      {},
    services:     {},

    // ── Projected payload — starts as a copy of canonical payload.
    // A payload.project trace contract may narrow or transform it.
    payload: { ...(canonicalPacket.payload || {}) },

    // ── Execution trace (populated as each stage runs)
    trace: {
      request_id: canonicalPacket.meta?.request_id || null,
      started_at: null,
      action:     null,
      steps:      [],
    },

    // ── Stamped at resolve() completion
    // provenance.contract answers: which exact contract governed this execution?
    //   template_content_hash — hash of the source template artifact as stored
    //   resolved_hash         — hash of the final merged contract (after all composes)
    //   composed_from         — every base template that contributed to the merge
    provenance: {
      actor:    ctx.user_id  || null,
      store:    ctx.store_id || null,
      contract: {
        template_id:           contract?.id                       || null,
        template_slug:         contract?.slug                     || null,
        template_content_hash: contract?.template_content_hash    || null,
        resolved_hash:         contract ? _hashContract(contract) : null,
        composed_from:         contract?.composed_from            || [],
        resolver_version:      '1',
      },
      resolved_at: null,
    },
  };
}

// Merge the contract's execution_trace after the defaults.
function _buildTraceList(contract) {
  const custom = Array.isArray(contract?.execution_trace) ? contract.execution_trace : [];
  return [...DEFAULT_TRACE, ...custom];
}

// Project only the dimensions declared in the stage's scope declaration
// into a lean context object for that specific trace handler.
// The scope declaration is a set of dimension keys the stage needs:
//   { identity: 'actor', tenant: 'current', services: ['storage'] }
function _projectScope(scopeDecl, ctx, canonicalPacket) {
  if (!scopeDecl || !Object.keys(scopeDecl).length) return { ...ctx };

  const projected = {};

  if (scopeDecl.identity) {
    projected.user_id      = ctx.user_id;
    projected.ark_actor_id = ctx.ark_actor_id;
  }
  if (scopeDecl.tenant)    projected.store_id     = ctx.store_id;
  if (scopeDecl.request)   projected.request_id   = ctx.request_id;
  if (scopeDecl.ip)        projected.ip           = ctx.ip;
  if (scopeDecl.source)    projected.source       = ctx.source;
  if (scopeDecl.role) {
    projected.role    = ctx.role;
    projected.role_id = ctx.role_id;
    projected.rank     = ctx.rank;
  }

  // services is a list of names the stage is allowed to use
  if (Array.isArray(scopeDecl.services)) {
    projected._allowed_services = scopeDecl.services;
  }

  return projected;
}

function _pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (key in (obj || {})) out[key] = obj[key];
  }
  return out;
}

function _applyMerge(target, source, strategy) {
  if (strategy === 'deep') {
    _deepAssign(target, source);
  } else {
    Object.assign(target, source);
  }
}

// SHA-256 of the fully resolved contract JSON — the "version" of the contract
// that governed this execution. Stored in provenance so any ledger record can
// answer: which exact contract definition was in effect?
function _hashContract(contract) {
  if (!contract) return null;
  try {
    return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  } catch {
    return null;
  }
}

function _deepAssign(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
        && target[k] !== null && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      _deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

module.exports = PCER;
module.exports._internals = { _emptyExecutionPacket, _buildTraceList, _projectScope, _pick, _applyMerge, _hashContract };
