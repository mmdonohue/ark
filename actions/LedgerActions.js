'use strict';

// LedgerActions — three roles:
//
// 1. PCER trace handler: ledger.open
//    Runs as a 'merge' stage after auth.verify. Creates the ledger record and
//    returns { ledger_id } to be merged into the ExecutionPacket.
//    Every authenticated execution gets a ledger entry.
//
// 2. Lifecycle methods: close() and error()
//    Called directly from action.js at egress — not PCER trace contracts.
//    Close stamps the final outcome; error stamps the failure.
//
// 3. Read actions: get() and list()
//    Registered in ACTION_REGISTRY. Always scoped to the actor's store_id.

const ArtifactLedger = require('../domain/ArtifactLedger');

// ── ledger.open — merge — payload: ['ledger_id'] ─────────────────────────────
async function open(stageCtx, canonicalPacket, ep) {
  const ledger = new ArtifactLedger({
    store_id:          stageCtx.store_id  || null,
    actor_id:          stageCtx.user_id   || null,
    action:            canonicalPacket.action,
    contract_id:       ep.contract_def?.id || null,
    canonical_payload: canonicalPacket.payload || {},
    resolved_contract: ep.contract_def ? {
      id:    ep.contract_def.id,
      slug:  ep.contract_def.slug,
      scope: ep.contract_def.scope || {},
    } : {},
    provenance: ep.provenance || {},
    status:     'open',
    // role read from ep, not stageCtx — ledger.open's own PCER scope
    // declaration doesn't project 'role' into stageCtx, but ep carries it
    // unconditionally (PCER.js sets ep.role from the full ctx at assembly
    // time, independent of per-stage scope projection).
  }, { context: { store_id: stageCtx.store_id, user_id: stageCtx.user_id, ark_actor_id: stageCtx.ark_actor_id, role: ep.role } });

  await ledger.save();
  return { ledger_id: ledger.id };
}

// ── close — called from action.js after successful handler + chain ────────────
async function close(ledgerId, { chainResult } = {}, ep) {
  if (!ledgerId) return;

  const duration = ep?.trace?.started_at
    ? Date.now() - new Date(ep.trace.started_at).getTime()
    : null;

  const ledger = new ArtifactLedger(
    { id: ledgerId },
    { context: { store_id: ep?.store_id, user_id: ep?.user_id, ark_actor_id: ep?.ark_actor_id, role: ep?.role } },
  );

  await ledger.close({
    resolution:      chainResult?.resolution || 'success',
    chain_id:        chainResult?.chain_id   || null,
    execution_trace: ep?.trace?.steps        || [],
    duration_ms:     duration,
  });
}

// ── error — called from action.js catch block ─────────────────────────────────
async function error(ledgerId, err, ep) {
  if (!ledgerId) return;

  const duration = ep?.trace?.started_at
    ? Date.now() - new Date(ep.trace.started_at).getTime()
    : null;

  const ledger = new ArtifactLedger(
    { id: ledgerId },
    { context: { store_id: ep?.store_id, user_id: ep?.user_id, ark_actor_id: ep?.ark_actor_id, role: ep?.role } },
  );

  await ledger.error(err, {
    execution_trace: ep?.trace?.steps || [],
    duration_ms:     duration,
  });
}

// ── ledger.get — payload: { ledger_id } ──────────────────────────────────────
async function get(ep) {
  const { ledger_id } = ep.payload;
  if (!ledger_id) throw Object.assign(new Error('ledger_id required'), { status: 400, code: 'MISSING_LEDGER_ID' });

  const { data, error: dbErr } = await ArtifactLedger.db
    .from('artifact_ledger')
    .select('*')
    .eq('id', ledger_id)
    .eq('store_id', ep.store_id)
    .maybeSingle();

  if (dbErr) throw new Error(dbErr.message);
  if (!data) throw Object.assign(new Error('Ledger entry not found'), { status: 404, code: 'LEDGER_NOT_FOUND' });

  return { data: { ledger: data } };
}

// ── ledger.list — payload: { action?, status?, actor_id?, limit?, cursor? } ──
async function list(ep) {
  const { action, status, actor_id, limit = 50, cursor } = ep.payload;

  let q = ArtifactLedger.db
    .from('artifact_ledger')
    .select('id, action, status, resolution, actor_id, opened_at, closed_at, duration_ms, error')
    .eq('store_id', ep.store_id)
    .order('opened_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (action)   q = q.eq('action', action);
  if (status)   q = q.eq('status', status);
  if (actor_id) q = q.eq('actor_id', actor_id);
  if (cursor)   q = q.lt('opened_at', cursor);

  const { data, error: dbErr } = await q;
  if (dbErr) throw new Error(dbErr.message);

  const rows = data || [];
  const next_cursor = rows.length === Math.min(limit, 200)
    ? rows[rows.length - 1].opened_at
    : null;

  return { data: { ledger: rows, next_cursor } };
}

module.exports = { open, close, error, get, list };
