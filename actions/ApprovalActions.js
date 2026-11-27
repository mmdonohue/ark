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

// The drift reviews still waiting, newest first.
function _pendingReviews(tasks, reviewsById) {
  const derived = new Set(tasks.map(t => _ctx(t).derived_from).filter(Boolean));
  const out = new Map();
  for (const t of tasks) {
    const c = _ctx(t);
    if (!c.inputs?.compare || c.state !== 'ready') continue;
    for (const check of c.watch?.checks || []) {
      const id = check.review_id;
      if (check.status !== 'reviewed' || !id || out.has(id) || derived.has(id)) continue;
      const r = reviewsById.get(id);
      if (!r || _ctx(r).dismissed) continue;
      out.set(id, {
        kind: 'review', id, title: r.title, at: check.at, task_id: t.id, task_title: t.title,
        summary: r.summary || null, drift: { new: (check.new || []).length, changed: (check.changed || []).length, drifting: check.drifting ?? null },
        settle: ['task.propose', 'review.dismiss'],
      });
    }
  }
  return [...out.values()];
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

// payload: {} → { items: [...], counts: { total, <kind>: n } }
async function queue(ctx, payload, packet) {
  const [tasks, runs, events, reviews] = await Promise.all([
    Artifact.query({ artifact_type: 'task', limit: 1000 }, ctx),
    Artifact.query({ artifact_type: 'workflow_run', limit: 1000 }, ctx),
    Artifact.query({ artifact_type: 'event', limit: 1000 }, ctx),
    Artifact.query({ artifact_type: 'review', limit: 1000, select: 'id, title, summary, context, created_at' }, ctx),
  ]);

  const items = [];
  for (const t of tasks) {
    const c = _ctx(t);
    if (c.state !== 'proposed') continue;
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
    if (c.state !== 'proposed') continue;
    items.push({ kind: 'run', id: r.id, title: r.title, at: r.updated_at || r.created_at || null, alias: c.definition?.alias || null, settle: ['workflow.approve'] });
  }
  items.push(...await _eventItems(ctx, events));
  items.push(..._pendingReviews(tasks, new Map(reviews.map(r => [r.id, r]))));

  items.sort((a, b) => _ts(b.at) - _ts(a.at));
  const counts = { total: items.length };
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  packet.log.push(`approval.queue → ${items.length} waiting`);
  return { data: { items, counts } };
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
  const dismissed = { by: _actor(ctx), at: new Date().toISOString(), ...(note ? { note } : {}) };
  review.assign({ context: { ...c, dismissed } });
  await review.save();
  await _recordEvent(ctx, { artifact_id: review.id, event_type: 'review.dismissed', event_name: 'Review dismissed', payload: dismissed });
  packet._objects['review'] = review.data;
  packet.log.push(`review.dismiss → ${review.id}`);
  return { data: { review_id: review.id, dismissed } };
}

module.exports = { queue, dismiss };
