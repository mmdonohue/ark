'use strict';

// ApprovalActions — one place to see what's waiting on the owner.
//
// approval.queue is a read over approvals that already exist; it adds no way
// to approve anything. Each item names the action that settles it, and that
// action keeps its own capability check and ledger entry:
//
//   task        a proposed task                       → task.approve
//   gated_step  a gated workflow step's proposed task → task.approve
//   pr_intent   a proposed PR intent                  → task.approve
//   run         a proposed workflow run               → workflow.approve
//   event       a scheduled workflow whose standing
//               approval is missing or stale          → event.approve_workflow
//   review      a drift review nobody has acted on    → task.propose (kind 'pr') or review.dismiss
//
// A drift review is one harness.watch produced (a drift task's
// watch.checks). It leaves the queue once a PR intent is derived from it
// (context.derived_from) or it's dismissed — review.dismiss, the one write
// here, which records who, when and why on the review.

const Artifact = require('../domain/Artifact');
const { _recordEvent } = require('./ArtifactActions');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const _ctx = r => (typeof r.context === 'string' ? JSON.parse(r.context || '{}') : (r.context || {}));
const _actor = ctx => ctx.user_id || ctx.ark_actor_id || null;
const _ts = v => (v ? Date.parse(v) || 0 : 0);

// Each source is read already narrowed to what can be waiting (filtered in
// the database), one row past CAP: a source with more than CAP is reported in
// `truncated` rather than silently cut short.
let CAP = 1000;

async function _read(ctx, name, query, truncated) {
  const rows = await Artifact.query({ ...query, limit: CAP + 1 }, ctx);
  if (rows.length > CAP) { truncated.push(name); rows.length = CAP; }
  return rows;
}

const _chunks = (xs, n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// Reviews a live PR intent was made from (its derived_from relation).
async function _derived(ctx, reviewIds) {
  const sources = [];
  for (const ids of _chunks(reviewIds)) {
    const { data, error } = await Artifact.db.from('artifact_relations')
      .select('source_artifact_id, target_artifact_id').eq('relation_type', 'derived_from').in('target_artifact_id', ids);
    if (error) throw new Error(error.message);
    sources.push(...(data || []));
  }
  if (!sources.length) return new Set();
  const live = new Set();
  for (const ids of _chunks([...new Set(sources.map(s => s.source_artifact_id))])) {
    for (const t of await Artifact.query({ artifact_type: 'task', ids, limit: ids.length, select: 'id' }, ctx)) live.add(t.id);
  }
  return new Set(sources.filter(s => live.has(s.source_artifact_id)).map(s => s.target_artifact_id));
}

// The drift reviews still waiting: from ready drift tasks' watch.checks,
// not dismissed, no PR intent made from them.
async function _pendingReviews(ctx, readyTasks) {
  const found = new Map();
  for (const t of readyTasks) {
    const c = _ctx(t);
    if (!c.inputs?.compare) continue;
    for (const check of c.watch?.checks || []) {
      if (check.status === 'reviewed' && check.review_id && !found.has(check.review_id)) found.set(check.review_id, { t, check });
    }
  }
  if (!found.size) return [];
  const ids = [...found.keys()];
  const reviews = new Map();
  for (const chunk of _chunks(ids)) {
    for (const r of await Artifact.query({ artifact_type: 'review', ids: chunk, limit: chunk.length, select: 'id, title, summary, context' }, ctx)) reviews.set(r.id, r);
  }
  const derived = await _derived(ctx, ids);
  const out = [];
  for (const [id, { t, check }] of found) {
    const r = reviews.get(id);
    if (!r || _ctx(r).dismissed || derived.has(id)) continue;
    out.push({
      kind: 'review', id, title: r.title, at: check.at, task_id: t.id, task_title: t.title,
      summary: r.summary || null, drift: { new: (check.new || []).length, changed: (check.changed || []).length, drifting: check.drifting ?? null },
      settle: ['task.propose', 'review.dismiss'],
    });
  }
  return out;
}

// An event that launches a workflow fires only on a standing approval that
// still matches the workflow (system.cycle checks the same).
async function _eventItems(ctx, events) {
  const { containingProjects } = require('./RepositoryActions');
  const { effectiveWorkflows } = require('./WorkflowDefinitionActions');
  const WR = require('./WorkflowRunActions');
  const out = [];
  for (const e of events) {
    const c = _ctx(e);
    if (c.state !== 'active' || c.action_ref?.kind !== 'workflow') continue;
    const base = { kind: 'event', id: e.id, title: e.title, alias: c.action_ref.alias, settle: ['event.approve_workflow'] };
    const standing = c.workflow_approval;
    if (!standing) { out.push({ ...base, reason: 'not_approved', at: e.updated_at || c.active_since || null }); continue; }
    try {
      const projects = await containingProjects(ctx, e.id);
      if (projects.length !== 1) continue; // can't fire either way; the event view says why
      const project = await Artifact.findById(projects[0].id, ctx);
      const def = (await effectiveWorkflows(ctx, project)).find(w => w.alias === c.action_ref.alias);
      if (!def || def.error) continue;
      if (WR.planHash(WR.snapshotDefinition(def)) !== standing.plan_hash) {
        out.push({ ...base, reason: 'stale', approved_revision: standing.revision, revision: def.revision, at: standing.at });
      }
    } catch { /* unreadable project: nothing to approve from here */ }
  }
  return out;
}

// payload: {} → { items: [...], counts: { total, <kind>: n }, truncated: [source…] }
// truncated names any source that had more than CAP candidates; the items
// from it are the CAP most recently updated.
async function queue(ctx, payload, packet) {
  const truncated = [];
  const state = s => [['context->>state', 'eq', s]];
  const [proposed, runs, events, ready] = await Promise.all([
    _read(ctx, 'tasks', { artifact_type: 'task', filters: state('proposed') }, truncated),
    _read(ctx, 'workflow_runs', { artifact_type: 'workflow_run', filters: state('proposed') }, truncated),
    _read(ctx, 'scheduled_workflows', { artifact_type: 'event', filters: [...state('active'), ['context->action_ref->>kind', 'eq', 'workflow']] }, truncated),
    _read(ctx, 'drift_tasks', { artifact_type: 'task', filters: state('ready') }, truncated),
  ]);

  const items = [];
  for (const t of proposed) {
    const c = _ctx(t);
    const kind = c.kind === 'pr' ? 'pr_intent' : c.workflow_run?.gate ? 'gated_step' : 'task';
    items.push({
      // updated_at: a revised task goes back to proposed, and that's when it started waiting
      kind, id: t.id, title: t.title, at: t.updated_at || t.created_at || null, settle: ['task.approve'],
      ...(c.workflow_run ? { run_id: c.workflow_run.run_id, step: c.workflow_run.step } : {}),
      ...(c.derived_from ? { derived_from: c.derived_from } : {}),
    });
  }
  for (const r of runs) {
    const c = _ctx(r);
    items.push({ kind: 'run', id: r.id, title: r.title, at: r.updated_at || r.created_at || null, alias: c.definition?.alias || null, settle: ['workflow.approve'] });
  }
  items.push(...await _eventItems(ctx, events));
  items.push(...await _pendingReviews(ctx, ready));

  items.sort((a, b) => _ts(b.at) - _ts(a.at));
  const counts = { total: items.length };
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  packet.log.push(`approval.queue → ${items.length} waiting${truncated.length ? ` (more than ${CAP}: ${truncated.join(', ')})` : ''}`);
  return { data: { items, counts, truncated } };
}

// payload: { review_id, note? } — the owner looked at a drift review and
// won't act on it. Recorded on the review and in its history; the review
// itself is unchanged and stays readable.
async function dismiss(ctx, payload, packet) {
  const { review_id } = payload;
  if (!review_id) throw _fail(400, 'REVIEW_REQUIRED', 'review_id is required');
  const review = await Artifact.findById(review_id, ctx);
  if (!review || review.get('artifact_type') !== 'review') throw _fail(404, 'NOT_FOUND', 'Review not found');
  const c = review.get('context') || {};
  if (c.dismissed) throw _fail(409, 'ALREADY_DISMISSED', `Already dismissed ${c.dismissed.at}`);
  const note = payload.note ? String(payload.note).trim().slice(0, 2000) : null;
  const at = new Date().toISOString();
  // id: which dismissal landed, when two share an actor and a millisecond
  const dismissed = { id: require('crypto').randomUUID(), by: _actor(ctx), at, ...(note ? { note } : {}) };

  // Optimistic: written only if the review hasn't changed since it was read
  // (its updated_at), then read back. Of two dismissals at once, one lands;
  // the other is refused and records nothing.
  const { error } = await Artifact.db.from('artifacts')
    .update({ context: { ...c, dismissed }, updated_at: at })
    .eq('id', review.id).eq('updated_at', review.get('updated_at'));
  if (error) throw new Error(`review.dismiss failed: ${error.message}`);
  const now = (await Artifact.findById(review.id, ctx))?.get('context') || {};
  if (now.dismissed?.id !== dismissed.id) {
    throw _fail(409, now.dismissed ? 'ALREADY_DISMISSED' : 'CONFLICT', now.dismissed ? `Already dismissed ${now.dismissed.at}` : 'The review changed while it was being dismissed; try again');
  }

  await _recordEvent(ctx, { artifact_id: review.id, event_type: 'review.dismissed', event_name: 'Review dismissed', payload: dismissed });
  packet.log.push(`review.dismiss → ${review.id}`);
  return { data: { review_id: review.id, dismissed } };
}

const _setCap = n => { CAP = n; }; // tests

module.exports = { queue, dismiss, _internals: { _setCap } };
