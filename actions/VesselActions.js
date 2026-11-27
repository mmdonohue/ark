'use strict';

// VesselActions — Lamb Mode on and off (docs/proposals/universal-lamb-mode.md).
//
// vessel.quiet and vessel.resume are the only way the mode changes, and only
// the owner acting in the foreground can call them: an agent's callback, a
// cycle or a resumed chain is refused whatever rank it carries. Nothing
// network-related touches the mode.

const Artifact = require('../domain/Artifact');
const { _recordEvent } = require('./ArtifactActions');
const vesselMode = require('../utils/vesselMode');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const _actor = ctx => ctx.user_id || ctx.ark_actor_id || null;
const _note = n => (n ? String(n).trim().slice(0, 2000) || null : null);

function _assertOwnerNow(ctx, action) {
  if (!vesselMode.isForegroundOwner(ctx)) {
    throw _fail(403, 'OWNER_ONLY', `${action} is the owner's call, made directly — not from an agent, a cycle or a resumed chain`);
  }
}

// What's still going in this process: started cycle work and agent runs.
function _running(store_id) {
  return { cycle: require('./SystemActions').running(store_id), harness: require('./HarnessActions').running(store_id) };
}

// payload: {} → { mode, since, by, note, running }
async function mode(ctx, payload, packet) {
  const m = await vesselMode.current(ctx.store_id);
  packet.log.push(`vessel.mode → ${m.mode}`);
  return { data: { mode: m.mode, since: m.since, by: m.by, note: m.note, running: _running(ctx.store_id) } };
}

// payload: { note?, cancel_running? } — background work stops being started.
// Work already running finishes, unless cancel_running: then every agent run
// in this process is cancelled (its task stays approved).
async function quiet(ctx, payload, packet) {
  _assertOwnerNow(ctx, 'vessel.quiet');
  const cur = await vesselMode.current(ctx.store_id);
  if (cur.mode === 'lamb') throw _fail(409, 'ALREADY_QUIET', `Lamb Mode has been on since ${cur.since}`);
  const fields = { mode: 'lamb', since: new Date().toISOString(), by: _actor(ctx), note: _note(payload.note), ...(cur.skip_before ? { skip_before: cur.skip_before } : {}) };
  const a = await vesselMode.set(ctx.store_id, ctx, fields, cur);
  const cancelled = payload.cancel_running ? require('./HarnessActions').cancelAll(ctx.store_id) : 0;
  await _recordEvent(ctx, { artifact_id: a.id, event_type: 'vessel.quiet', event_name: 'Lamb Mode on', payload: { ...fields, cancelled } });
  packet.log.push(`vessel.quiet → on${cancelled ? `, ${cancelled} agent run(s) cancelled` : ''}`);
  return { data: { ...fields, cancelled, running: _running(ctx.store_id) } };
}

// payload: { note?, missed?: 'latest' | 'skip' } — background work starts
// again. latest (default): the next tick fires each event's latest due
// occurrence once, the cycle's usual catch-up (within its lookback window).
// skip: a vessel-wide watermark prevents occurrences due before resume.
async function resume(ctx, payload, packet) {
  _assertOwnerNow(ctx, 'vessel.resume');
  const missed = payload.missed ?? 'latest';
  if (!['latest', 'skip'].includes(missed)) throw _fail(400, 'BAD_MISSED', 'missed is "latest" or "skip"');
  const cur = await vesselMode.current(ctx.store_id);
  if (cur.mode !== 'lamb') throw _fail(409, 'NOT_QUIET', 'Lamb Mode is not on');

  let events = [];
  if (missed === 'skip') {
    const rows = await Artifact.query({ artifact_type: 'event', limit: 10000, filters: [['context->>state', 'eq', 'active']] }, ctx);
    events = rows.filter(e => (typeof e.context === 'string' ? JSON.parse(e.context) : e.context)?.schedule);
  }

  const now = new Date().toISOString();
  const skip_before = missed === 'skip' ? now : cur.skip_before;
  const fields = { mode: 'normal', since: now, by: _actor(ctx), note: _note(payload.note), quiet_since: cur.since, ...(skip_before ? { skip_before } : {}) };
  const a = await vesselMode.set(ctx.store_id, ctx, fields, cur);
  for (const e of events) {
    await _recordEvent(ctx, { artifact_id: e.id, event_type: 'event.missed_skipped', event_name: 'Missed while quiet — skipped', payload: { quiet_since: cur.since, skip_before: now } });
  }
  const skipped = events.length;
  await _recordEvent(ctx, { artifact_id: a.id, event_type: 'vessel.resumed', event_name: 'Lamb Mode off', payload: { ...fields, missed, skipped } });
  packet.log.push(`vessel.resume → off (missed: ${missed}${skipped ? `, ${skipped} event(s) skipped` : ''})`);
  return { data: { ...fields, missed, skipped } };
}

module.exports = { mode, quiet, resume };
