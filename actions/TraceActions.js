'use strict';

// TraceActions — default PCER trace contract handlers.
//
// These run for every contract in order:
//   trace.open    → void  — stamps trace start, logs ingress
//   auth.verify   → gate  — confirms actor + tenant are present
//   scope.resolve → merge — resolves scope + capability set into the ExecutionPacket
//
// Registered in PCER_REGISTRY in routes/action.js, not in ACTION_REGISTRY.
// Contracts are pure: they receive only the scope projected for their stage.

let _logger;
function logger() {
  if (!_logger) {
    try { _logger = require('log4js').getLogger('tracer'); }
    catch { _logger = console; }
  }
  return _logger;
}

// ── trace.open — void ─────────────────────────────────────────────────────────
// Stamps the execution packet with a start time and action name.
// Side effect only — contributes nothing to the packet.
async function open(stageCtx, canonicalPacket, ep) {
  ep.trace.started_at = new Date().toISOString();
  ep.trace.action     = canonicalPacket.action;
  logger().debug(`[trace.open]  req=${stageCtx.request_id}  action=${canonicalPacket.action}`);
}

// ── auth.verify — gate ────────────────────────────────────────────────────────
// Confirms the execution context carries a valid actor and tenant.
// Transport-level auth (JWT / session) is resolved upstream by resolveUserContext.
// This is the execution layer's own check: required actor + tenant for any contract.
async function verify(stageCtx, canonicalPacket, ep) {
  // An actor is either a Seravanna-linked user_id (legacy, cloud-attached),
  // an ARK-native ark_actor_id (local-only, no cloud account required —
  // e.g. a hiker running ARK entirely off a USB drive), or an anonymous
  // GUEST — declared anonymity is a real capacity here, not a missing one.
  // ARK does not require a cloud account to be used.
  if (!stageCtx.user_id && !stageCtx.ark_actor_id && stageCtx.role !== 'GUEST') {
    throw Object.assign(
      new Error('Execution requires an authenticated actor (user_id or ark_actor_id)'),
      { status: 401, code: 'AUTH_NO_ACTOR' },
    );
  }
  if (!stageCtx.store_id) {
    throw Object.assign(
      new Error('Execution requires a tenant context'),
      { status: 401, code: 'AUTH_NO_TENANT' },
    );
  }
  if (!stageCtx.role) {
    throw Object.assign(
      new Error('Execution requires a role — every actor context must declare who they are and in what capacity (see roles table: ADMIN/PARTNER/TECH/USER)'),
      { status: 401, code: 'AUTH_NO_ROLE' },
    );
  }
}

// ── scope.resolve — merge — payload: ['scope', 'capabilities'] ───────────────
// Resolves the execution scope and capability set for this actor + action.
// Returns { scope, capabilities } — merged into the ExecutionPacket by PCER.
//
// Currently returns sensible defaults scoped to the action's domain.
// RBAC / policy narrowing plugs in here when built.
async function resolveScope(stageCtx, canonicalPacket, ep) {
  const action         = canonicalPacket.action || '';
  const [domain, verb] = action.split('.');
  const requested      = ep.contract_def?.scope || {};

  // granted = requested for now — Phase 8 (PolicyResolver) narrows this
  // denied  = empty for now — Phase 8 populates what policy narrowed out
  return {
    scope: {
      requested,
      granted:  { ...requested },
      denied:   {},
      identity: { user_id: stageCtx.user_id, ark_actor_id: stageCtx.ark_actor_id },
      tenant:   { store_id: stageCtx.store_id },
      role:     { role: stageCtx.role, rank: stageCtx.rank },
      domain:   domain || null,
    },
    capabilities: _defaultCapabilities(domain, verb, stageCtx.rank),
  };
}

// ── payload.project — merge — payload: ['payload'] ───────────────────────────
// Projects ep.payload against the contract's declared fields.
// Validates required fields, strips undeclared keys, applies field defaults.
// No-op (returns {}) when the contract declares no fields.
async function projectPayload(stageCtx, canonicalPacket, ep) {
  const fields = ep.contract_def?.fields;
  if (!fields?.length) return {};

  const projected = {};
  const errors    = [];

  for (const field of fields) {
    const val = ep.payload[field.key];
    const missing = val === undefined || val === null || val === '';

    if (field.required && missing) {
      errors.push(`${field.key} is required`);
      continue;
    }

    if (!missing) {
      projected[field.key] = val;
    } else if (field.default !== undefined) {
      projected[field.key] = field.default;
    }
  }

  if (errors.length) {
    throw Object.assign(
      new Error(`Payload validation failed: ${errors.join(', ')}`),
      { status: 400, code: 'PAYLOAD_INVALID' },
    );
  }

  // Merged onto ep.payload, not returned alone — PCER.js's generic 'merge'
  // response type does Object.assign(ep, { payload: <this> }), which
  // REPLACES ep.payload wholesale with whatever this function returns. A
  // template's `fields` describes the shape of entries captured within an
  // ark of that type (JournalCapture, the Packet Builder), not the shape
  // of the ark.create/ark.update payload itself — those two things share
  // the same resolved contract only because template_id happens to be in
  // both payloads. Returning just `projected` silently dropped every
  // create/update field the template didn't happen to declare (summary,
  // is_arc, metadata, visibility — confirmed live: creating a Journal-
  // templated Ark with a summary silently discarded it). Every real
  // consumer downstream (ArkActions.create/update, ArtifactActions.*)
  // already applies its own explicit allowlist, so this narrowing was
  // never load-bearing as a security boundary — just accidental data loss.
  return { payload: { ...ep.payload, ...projected } };
}

// ── service.bind — merge — payload: ['services'] ─────────────────────────────
// Injects runtime services declared in the contract's scope.services list.
// Returns { services: { [name]: instance } } — merged into the ExecutionPacket.
// No-op (returns {}) when the contract declares no services or Manifest isn't ready.
async function bindServices(stageCtx, canonicalPacket, ep) {
  const declared = ep.contract_def?.scope?.services;
  if (!declared?.length) return {};

  const services = {};
  let Packet;
  try { Packet = require('../core/Packet'); } catch { return {}; }

  for (const name of declared) {
    try {
      const svc = Packet.service(name);
      if (svc) services[name] = svc;
    } catch { /* not registered — skip silently */ }
  }

  return { services };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Minimum rank required to hold a capability, regardless of domain/verb.
// Ranks mirror the real `roles` table (ADMIN 100 / PARTNER 80 / TECH 60 /
// USER 10) — see CHARTER.md addendum. Only capabilities
// that are genuinely more consequential than ordinary local artifact work
// get a floor here; everything else stays open to any authenticated role,
// same as before role existed in this model.
const RANK_REQUIRED = {
  'sync.write':      100, // writes into the shared Postgres/Supabase project — owner only
  'ark_actor.write': 100, // creating a new identity on the vessel — owner only
  'catalog.write':   100, // writes real commerce data (items/store_items) — owner only
  'pipeline.manage': 100, // registers a recipe directory as a real pipeline artifact — owner only
};

// GUEST (rank 0, anonymous — see TraceActions.verify) gets an explicit
// allowlist rather than a denylist/suffix heuristic: safer by construction,
// since every future write-flavored capability is guest-denied by default
// unless someone deliberately adds it here. Visibility (which artifacts a
// guest's artifact.read actually resolves to) is enforced separately, in
// Artifact.query()/findById() — this only decides which capability *names*
// a guest can hold at all.
const GUEST_CAPABILITIES = new Set(['artifact.read', 'template.read', 'artifact.like']);

function _defaultCapabilities(domain, verb, rank = null) {
  const caps = [];

  if (domain === 'artifact' || domain === 'ark') {
    caps.push('artifact.read');
    if (['create', 'update', 'archive', 'add_media', 'remove_media',
         'relate', 'unrelate', 'add_artifact', 'remove_artifact',
         'move_artifact', 'reorder_artifacts'].includes(verb)) {
      caps.push('artifact.write');
    }
    if (verb === 'create')     caps.push('artifact.create');
    if (verb === 'archive')    caps.push('artifact.archive');
    if (verb === 'resolve_url') caps.push('artifact.read');
    // Its own capability, deliberately never folded into artifact.write —
    // liking is the one write anyone (including GUEST) may do to ANY
    // visible artifact, not just their own. See GUEST_CAPABILITIES below.
    if (verb === 'like')       caps.push('artifact.like');
  }

  if (domain === 'workflow') {
    caps.push('workflow.read');
    if (['start', 'complete_task'].includes(verb)) caps.push('workflow.execute');
  }
  if (domain === 'template') caps.push('template.read');
  if (domain === 'chain')    caps.push('chain.read');
  if (domain === 'ledger')   caps.push('ledger.read');

  if (domain === 'chat') {
    caps.push('artifact.read');
    if (verb === 'import') caps.push('artifact.write', 'artifact.create');
  }

  if (domain === 'sync') {
    if (verb === 'push') caps.push('sync.write');
  }

  if (domain === 'source' && verb === 'discover') caps.push('filesystem.read');

  if (domain === 'media') {
    if (verb === 'fingerprint')                          caps.push('filesystem.read');
    if (verb === 'preserve' || verb === 'persist_pairing') caps.push('artifact.write');
    if (verb === 'classify' || verb === 'classify_batch') caps.push('media.classify');
    if (verb === 'detect_scenes')                         caps.push('filesystem.write');
  }

  if (domain === 'cache' && (verb === 'partition' || verb === 'materialize_bucket')) caps.push('filesystem.write');
  if (domain === 'cache' && verb === 'promote_bucket') caps.push('artifact.write');

  if (domain === 'pipeline') {
    if (verb === 'run')  caps.push('pipeline.execute');
    if (verb === 'list') caps.push('pipeline.read');
    if (verb === 'register') caps.push('pipeline.manage');
  }

  if (domain === 'ark_actor') {
    if (verb === 'create') caps.push('ark_actor.write');
  }

  if (domain === 'catalog') {
    if (verb === 'generate_sale_code')  caps.push('catalog.write');
    // Any logged-in user may redeem — deliberately NOT in GUEST_CAPABILITIES
    // (no RANK_REQUIRED floor either: the code itself is the authorization,
    // not rank) so only an anonymous caller (rank 0) is filtered out below,
    // since redemption attributes the claim to ctx.user_id.
    if (verb === 'redeem_sale_code')    caps.push('catalog.redeem');
  }

  const filtered = caps.filter(cap => {
    const required = RANK_REQUIRED[cap];
    if (required == null) return true;
    return rank != null && rank >= required;
  });

  if (rank === 0) return filtered.filter(cap => GUEST_CAPABILITIES.has(cap));
  return filtered;
}

module.exports = { open, verify, resolveScope, projectPayload, bindServices };
module.exports._internals = { _defaultCapabilities, RANK_REQUIRED, GUEST_CAPABILITIES };
