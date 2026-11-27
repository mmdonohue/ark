'use strict';

// SystemActions.cycle — fires due event occurrences. The clock is external
// (launchd, cron, the Mission Control button); each call looks back over a
// window, finds what came due, and claims it before acting.
//
// Claims. An occurrence's identity is (event, schedule_version, due_at). Its
// claim is an `artifact_chains` row whose primary key is a UUIDv5 of that
// identity, written with a raw insert — the first insert wins, any other
// process (a second timer, a button click) gets a duplicate key and skips.
// Packet.save() can't be used: with an id already set it updates instead.
//
// Claim rows never use 'pending' / 'running'. ChainExecutor.resume() re-runs
// those at boot by calling handlers directly, outside dispatch() and its rank
// checks. An occurrence chain goes claimed → occurred | dispatched | blocked |
// failed; one interrupted mid-run stays 'claimed' — at most once, visibly
// stuck rather than fired twice. 'claimed' also means "work still running",
// so a claim is called stale only after STALE_AFTER_MS (its started_at).
//
// Misfires. Only the latest due occurrence per event fires; older ones in the
// window are skipped (a daily event missed for three days runs once). Nothing
// before `active_since` counts — creating, rescheduling or resuming an event
// never fires what came due before it.
//
// Work. An event's action_ref task is requested through dispatch() with the
// caller's identity, so it gets its own capability check and ledger entry:
// a drift-watch task (inputs.compare) → harness.watch, any other → harness.run.

const crypto = require('crypto');
const Artifact = require('../domain/Artifact');
const { _recordEvent } = require('./ArtifactActions');
const { _childCtx } = require('./WorkflowActions')._internals;
const S = require('../utils/eventSchedule');

const HOUR = 3600000;
const DEFAULT_LOOKBACK_H = 24;
const MAX_LOOKBACK_H = 168;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
// A claim still 'claimed' after this long is reported stale: its process
// most likely died mid-run. Longer than a harness run's 15-minute timeout.
const STALE_AFTER_MS = 60 * 60 * 1000;
// Fixed namespace for occurrence ids — changing it would re-fire everything.
const OCCURRENCE_NS = '5c6e2a4e-3f1b-4d8a-9a57-0e1f7c2b9d41';

const _iso = ms => new Date(ms).toISOString();

function _uuidv5(name, ns = OCCURRENCE_NS) {
  const h = crypto.createHash('sha1').update(Buffer.from(ns.replace(/-/g, ''), 'hex')).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const occurrenceId = (eventId, version, dueAt) => _uuidv5(`${eventId}|${version}|${dueAt}`);

// Postgres 23505 (PostgREST returns it as error), SQLite throws.
const _isDuplicate = e => !!e && (e.code === '23505' || /SQLITE_CONSTRAINT|UNIQUE constraint|duplicate key/i.test(`${e.code || ''} ${e.message || ''}`));

async function _claim(ctx, id, context) {
  let error;
  try {
    ({ error } = await Artifact.db.from('artifact_chains').insert({
      id, store_id: ctx.store_id ?? null, principal_id: ctx.user_id ?? null,
      action: 'event.occurrence', status: 'claimed', context, started_at: _iso(Date.now()),
    }));
  } catch (err) { error = err; }
  if (!error) return true;
  if (_isDuplicate(error)) return false;
  throw new Error(`occurrence claim failed: ${error.message}`);
}

async function _settle(id, status, context, error = null) {
  const { error: e } = await Artifact.db.from('artifact_chains')
    .update({ status, context, error, completed_at: _iso(Date.now()) }).eq('id', id);
  if (e) throw new Error(`occurrence settle failed: ${e.message}`);
}

// The latest occurrence in (since, now], or null.
function _latestDue(c, since, now) {
  const due = S.occurrences(c.schedule, c.timezone, { from: since, to: now + 1, limit: 10000 });
  return due.length ? due[due.length - 1] : null;
}

// A workflow ref: launch a run (through dispatch, so it has its own ledger
// row) and approve it on the event's standing approval — only while that
// approval matches the workflow as it is now. Each occurrence is claimed
// once, so it launches at most one run.
async function _launchWorkflow(ctx, ref, eventId, dueAt) {
  const { containingProjects } = require('./RepositoryActions');
  const { effectiveWorkflows } = require('./WorkflowDefinitionActions');
  const WR = require('./WorkflowRunActions');
  const ev = await Artifact.findById(eventId, ctx);
  const standing = ev?.get('context')?.workflow_approval;
  if (!standing) throw Object.assign(new Error(`Workflow "${ref.alias}" isn't approved on this event yet`), { status: 409, code: 'WORKFLOW_NOT_APPROVED' });
  const projects = await containingProjects(ctx, eventId);
  if (projects.length !== 1) throw Object.assign(new Error('The event isn\'t in exactly one project'), { status: 409, code: 'PROJECT_AMBIGUOUS' });
  const project = await Artifact.findById(projects[0].id, ctx);
  const def = (await effectiveWorkflows(ctx, project)).find(w => w.alias === ref.alias);
  if (!def || def.error) throw Object.assign(new Error(`Workflow "${ref.alias}" is ${def ? 'invalid' : 'gone'}`), { status: 409, code: 'ACTION_REF_NOT_FOUND' });
  if (WR.planHash(WR.snapshotDefinition(def)) !== standing.plan_hash) {
    throw Object.assign(new Error(`Workflow "${ref.alias}" changed since its schedule was approved (r${standing.revision} → r${def.revision}) — approve it again on the event`), { status: 409, code: 'WORKFLOW_APPROVAL_STALE' });
  }

  const { dispatch } = require('../core/dispatch'); // lazy: dispatch requires this module
  const child = { ..._childCtx(ctx), source: 'system.cycle' };
  const out = await dispatch(
    { action: 'workflow.launch', payload: { project_id: project.id, alias: ref.alias, note: `scheduled: ${ev.get('title')} (${dueAt})` }, meta: { parent_request_id: ctx.request_id || null, event_id: eventId, due_at: dueAt } },
    child,
  );
  const run_id = out.data.run.id;
  const packet = { log: [], _objects: {}, events: {} };
  try {
    await WR.approveStanding(child, run_id, standing, { event_id: eventId, due_at: dueAt }, packet);
  } catch (err) {
    // Not approved (approveStanding only throws before approving): don't
    // leave a proposed run behind that could be approved by hand, outside
    // the schedule. The occurrence reports the reason.
    await WR.cancel(child, { run_id, note: `scheduled launch not approved: ${err.code || 'ERROR'}` }, packet).catch(() => {});
    throw Object.assign(err, { run_id });
  }
  return { action: 'workflow.launch', run_id, alias: ref.alias, revision: def.revision };
}

async function _work(ctx, ref, eventId, dueAt) {
  if (ref.kind === 'workflow') return _launchWorkflow(ctx, ref, eventId, dueAt);
  const task = await Artifact.findById(ref.id, ctx);
  if (!task || task.get('artifact_type') !== 'task') {
    throw Object.assign(new Error('action_ref task not found'), { status: 404, code: 'ACTION_REF_NOT_FOUND' });
  }
  const action = task.get('context')?.inputs?.compare ? 'harness.watch' : 'harness.run';
  const { dispatch } = require('../core/dispatch'); // lazy: dispatch requires this module
  const out = await dispatch(
    { action, payload: { task_id: ref.id }, meta: { parent_request_id: ctx.request_id || null, event_id: eventId, due_at: dueAt } },
    { ..._childCtx(ctx), source: 'system.cycle' },
  );
  const d = out.data || {};
  return {
    action,
    ...(d.status ? { status: d.status } : {}),
    ...(d.review?.id ? { review_id: d.review.id } : {}),
    ...(d.cached != null ? { cached: d.cached } : {}),
  };
}

// Requests one claimed occurrence's work, then settles the claim and writes
// history. Never throws: every outcome, including a broken settle, comes back
// as a result.
async function _finish(ctx, { id, claimCtx, ref, base }) {
  let outcome, result = null, error = null;
  if (!ref) {
    outcome = 'occurred';
  } else {
    try {
      result = await _work(ctx, ref, base.event_id, base.due_at);
      outcome = 'dispatched';
    } catch (err) {
      // 4xx = the work refused to start (not ready, not found, not allowed);
      // anything else broke while running.
      outcome = err.status >= 400 && err.status < 500 ? 'blocked' : 'failed';
      error = { code: err.code || null, message: String(err.message || err).slice(0, 300) };
    }
  }

  try {
    await _settle(id, outcome, { ...claimCtx, ...(result ? { result } : {}) }, error);
    await _recordEvent(ctx, {
      artifact_id: base.event_id, event_type: 'event.occurred',
      event_name: { occurred: 'Occurred', dispatched: 'Occurred — work requested', blocked: 'Occurred — work blocked', failed: 'Occurred — work failed' }[outcome],
      payload: { due_at: base.due_at, schedule_version: base.schedule_version, outcome, occurrence_id: id, ...(ref ? { action_ref: ref } : {}), ...(result ? { result } : {}), ...(error ? { error } : {}) },
      related_artifact_id: ref?.id || result?.run_id || null,
    });
  } catch (err) {
    // The claim holds — the occurrence won't fire again — but say so. A row
    // left 'claimed' past STALE_AFTER_MS is shown as stale, never re-run.
    error = { ...(error || {}), record: err.message };
  }
  return { ...base, outcome, ...(result ? { result } : {}), ...(error ? { error } : {}) };
}

// At most `n` at a time, in order; allSettled so one rejection can't strand
// the rest (_finish doesn't throw, but the pool shouldn't depend on that).
async function _pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const k = next++;
      const [r] = await Promise.allSettled([fn(items[k])]);
      out[k] = r.status === 'fulfilled' ? r.value
        : { ...items[k].base, outcome: 'failed', error: { code: null, message: String(r.reason?.message || r.reason).slice(0, 300) } };
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

// Work started by a cycle that returned before it finished. drain() lets a
// test or a shutting-down process wait for it.
const inflight = new Map();
function _background(promise, store_id) {
  const p = promise
    .catch(err => console.error(`  ✗ system.cycle background work: ${err.message}`))
    .finally(() => inflight.delete(p));
  inflight.set(p, String(store_id ?? ''));
}
const drain = () => Promise.allSettled([...inflight.keys()]);
const running = store_id => store_id === undefined
  ? inflight.size
  : [...inflight.values()].filter(store => store === String(store_id ?? '')).length;

// payload: { lookback_hours?, dry_run?, wait?, concurrency? }
//
// Two phases. Claims are taken one at a time — that ordering is what makes an
// occurrence fire once. The claimed work then runs through a pool, at most
// `concurrency` (default 2, max 4) at a time: each harness run spawns a local
// agent CLI and shares its provider limits.
//
// By default the cycle returns once everything is claimed, with work still
// running as outcome 'claimed'; each settles on its own claim row and in the
// event's history. wait: true holds the response until all of it settles —
// a short-lived caller (the CLI, launchd) must wait or its work dies with it.
async function cycle(ctx, payload, packet) {
  // Lamb Mode: the timer keeps ticking and nothing is claimed, so nothing is
  // marked fired or blocked — what came due is decided on vessel.resume. A
  // dry run still answers (it's how resume previews what would fire).
  const m = await require('../utils/vesselMode').current(ctx.store_id);
  if (!payload.dry_run && m.mode === 'lamb') {
    packet.log.push('system.cycle → quiet (Lamb Mode): nothing claimed');
    return { data: { quiet: true, since: m.since, results: [], already_claimed: 0 } };
  }
  const now = Date.now();
  const lookback = Math.min(Math.max(Number(payload.lookback_hours) || DEFAULT_LOOKBACK_H, 1), MAX_LOOKBACK_H);
  const concurrency = Math.min(Math.max(Number(payload.concurrency) || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENCY);
  const floor = now - lookback * HOUR;

  const rows = await Artifact.query({ artifact_type: 'event', limit: 1000 }, ctx);
  const results = [];
  const jobs = [];
  let skipped = 0;

  for (const row of rows) {
    const c = typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {});
    if (c.state !== 'active' || !c.schedule) continue;
    const since = Math.max(floor, Date.parse(c.active_since || row.created_at) || floor, Date.parse(m.skip_before) || floor);
    const t = _latestDue(c, since, now);
    if (t == null) continue;

    const due_at = _iso(t);
    const version = c.schedule_version || 1;
    const id = occurrenceId(row.id, version, due_at);
    const ref = c.action_ref || null;
    const base = { event_id: row.id, title: row.title, due_at, schedule_version: version, occurrence_id: id };

    // A dry run reports only what a real cycle would fire now: an occurrence
    // already claimed (fired before) is counted as such, not listed as due.
    if (payload.dry_run) {
      const { data: claimed, error } = await Artifact.db.from('artifact_chains').select('id').eq('id', id).limit(1);
      if (error) throw new Error(`Could not preview occurrence ${id}: ${error.message}`);
      if (claimed?.length) { skipped++; continue; }
      results.push({ ...base, outcome: 'due', action_ref: ref });
      continue;
    }

    const claimCtx = { kind: 'event_occurrence', event_id: row.id, due_at, schedule_version: version, action_ref: ref, request_id: ctx.request_id || null };
    try {
      if (!await _claim(ctx, id, claimCtx)) { skipped++; continue; }
    } catch (err) {
      results.push({ ...base, outcome: 'error', code: 'CLAIM_FAILED', message: err.message });
      continue;
    }
    // No work to request: settle now, it's two writes.
    if (!ref) results.push(await _finish(ctx, { id, claimCtx, ref, base }));
    else jobs.push({ id, claimCtx, ref, base });
  }

  if (jobs.length) {
    const work = _pool(jobs, concurrency, job => _finish(ctx, job));
    if (payload.wait) results.push(...await work);
    else {
      _background(work, ctx.store_id);
      results.push(...jobs.map(j => ({ ...j.base, outcome: 'claimed', action_ref: j.ref })));
    }
  }

  const tally = results.reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] || 0) + 1 }), {});
  const running = payload.wait ? 0 : jobs.length;
  packet.log.push(`system.cycle → ${results.length} due${payload.dry_run ? ' (dry run)' : ''}${running ? `, ${running} running` : ''}, ${skipped} already claimed, lookback ${lookback}h`);
  return { data: { at: _iso(now), lookback_hours: lookback, dry_run: !!payload.dry_run, results, running, already_claimed: skipped, tally, stale_after_ms: STALE_AFTER_MS } };
}

module.exports = { cycle, drain, running, STALE_AFTER_MS, _internals: { occurrenceId, _uuidv5, _pool } };
