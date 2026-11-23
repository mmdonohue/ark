'use strict';

// TaskActions — creating task intent without authorizing it.
//
// task.propose writes an artifact_type 'task' whose state is always
// 'proposed', whatever the caller asks for. A proposal can't run:
// harness.run refuses it until someone with authority changes its state to
// 'ready' (task.approve). That keeps "an agent suggested this work" and
// "this work was approved" as two distinct, separately ledgered acts.
//
// Lifecycle, owned by these actions only: artifact.create and an
// artifact.update that turns something into a task both enter it at
// 'proposed', and artifact.update refuses to change state/approved/completed
// on an existing task.
//
//   proposed ──task.approve──▶ ready ──task.complete──▶ resolved
//       ▲                        │                          │
//       └──────── task.revise ───┴──────────────────────────┘
//
// Approval covers a scope (utils/taskScope.js): inputs, capabilities,
// constraints, execution_policy. task.approve pins its hash; artifact.update
// can't change it afterwards, and task.revise — the only way to — sends the
// task back to 'proposed' so the new scope is approved on its own.
//
// Approving, completing and revising are an admin's acts — rank 100 (a Seravanna
// ADMIN, or a local vessel's owner), see TraceActions.RANK_REQUIRED.

const path = require('path');
const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');
const { effectiveContext, inheritError } = require('./RepositoryActions');
const { SCOPE_KEYS, scopeHash, scopeChanged, policyError } = require('../utils/taskScope');
const usage = require('../utils/usage');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });

async function _loadTask(ctx, task_id) {
  if (!task_id) throw _fail(400, 'MISSING_TASK_ID', 'task_id is required');
  const task = await Artifact.findById(task_id, ctx);
  if (!task || task.get('artifact_type') !== 'task') throw _fail(404, 'NOT_FOUND', 'Task not found');
  return task;
}

function _expectState(tctx, from, verb) {
  if (tctx.state !== from) {
    throw _fail(409, 'TASK_STATE', `Task is ${tctx.state || 'unstated'}; only a ${from} task can be ${verb}`);
  }
}

const _actor = ctx => ctx.user_id || ctx.ark_actor_id || null;
const _note  = n => (n == null ? null : String(n).trim().slice(0, 2000) || null);

// payload: { task_id, note? }
async function approve(ctx, payload, packet) {
  const task = await _loadTask(ctx, payload.task_id);
  const tctx = task.get('context') || {};
  _expectState(tctx, 'proposed', 'approved');
  const badPolicy = policyError(tctx.execution_policy);
  if (badPolicy) throw _fail(422, 'BAD_POLICY', `${badPolicy} — fix it with task.revise before approving`);

  const note = _note(payload.note);
  // The hash covers the effective scope — repositories inherited from the
  // project included — so a later change there needs a new approval.
  const effective = await effectiveContext(ctx, task);
  const approved = { by: _actor(ctx), at: new Date().toISOString(), scope_hash: scopeHash(effective), ...(note ? { note } : {}) };
  task.assign({ context: { ...tctx, state: 'ready', approved } });
  await task.save();

  await _recordEvent(ctx, {
    artifact_id: task.id, event_type: 'task.approved', event_name: 'Task approved',
    payload: { from: 'proposed', to: 'ready', ...approved },
  });

  packet._objects['task'] = task.data;
  packet.log.push(`task.approve → ${task.id} proposed → ready`);
  return { data: { task: task.data } };
}

// payload: { task_id, note?, artifacts?: [artifact_id] }
// Evidence artifacts must be visible to the completer; each is linked with
// an `evidence` relation so it shows up in the task's graph.
async function complete(ctx, payload, packet) {
  const task = await _loadTask(ctx, payload.task_id);
  const tctx = task.get('context') || {};
  _expectState(tctx, 'ready', 'completed');

  const ids = payload.artifacts ?? [];
  if (!Array.isArray(ids) || ids.length > 20) throw _fail(400, 'BAD_EVIDENCE', 'artifacts must be an array of at most 20 ids');
  for (const id of ids) {
    if (!(await Artifact.findById(id, ctx))) throw _fail(404, 'EVIDENCE_NOT_FOUND', `Evidence artifact not found: ${id}`);
  }

  const note = _note(payload.note);
  const completed = {
    by: _actor(ctx), at: new Date().toISOString(),
    evidence: { ...(note ? { note } : {}), artifacts: ids },
  };
  task.assign({ context: { ...tctx, state: 'resolved', completed } });
  await task.save();

  for (const id of ids) {
    await new ArtifactRelation({
      source_artifact_id: task.id, target_artifact_id: id, relation_type: 'evidence',
    }, { context: ctx }).save();
  }

  await _recordEvent(ctx, {
    artifact_id: task.id, event_type: 'task.completed', event_name: 'Task completed',
    payload: { from: 'ready', to: 'resolved', ...completed },
  });

  packet._objects['task'] = task.data;
  packet.log.push(`task.complete → ${task.id} ready → resolved${ids.length ? ` (${ids.length} evidence)` : ''}`);
  return { data: { task: task.data } };
}

const REVISABLE_STATES = new Set(['proposed', 'ready', 'resolved']);
const _isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const SCOPE_SHAPE = {
  inputs:                v => _isObject(v),
  required_capabilities: v => Array.isArray(v) && v.every(c => typeof c === 'string'),
  constraints:           v => _isObject(v),
  execution_policy:      v => _isObject(v),
};

// payload: { task_id, changes: { inputs?, required_capabilities?, constraints?, execution_policy? }, note? }
// Each key given replaces that key whole (null removes it). A changed scope
// is new, unapproved work: the task goes back to 'proposed', and the approval
// and completion it had move into the task.revised event.
async function revise(ctx, payload, packet) {
  const task = await _loadTask(ctx, payload.task_id);
  const tctx = task.get('context') || {};
  if (!REVISABLE_STATES.has(tctx.state)) {
    throw _fail(409, 'TASK_STATE', `Task is ${tctx.state || 'unstated'}; only a proposed, ready or resolved task can be revised`);
  }

  const changes = payload.changes;
  if (!_isObject(changes)) throw _fail(400, 'BAD_CHANGES', 'changes must be an object');
  const unknown = Object.keys(changes).filter(k => !SCOPE_KEYS.includes(k));
  if (unknown.length) throw _fail(400, 'BAD_CHANGES', `Not revisable here: ${unknown.join(', ')} (scope keys are ${SCOPE_KEYS.join(', ')})`);
  for (const [k, v] of Object.entries(changes)) {
    if (v !== null && !SCOPE_SHAPE[k](v)) throw _fail(400, 'BAD_CHANGES', `${k} has the wrong shape`);
  }
  const badPolicy = policyError(changes.execution_policy);
  if (badPolicy) throw _fail(400, 'BAD_POLICY', badPolicy);
  // A PR intent's scope is its PR: the same invariants task.propose sets
  // hold after any revise — inputs are exactly { pr } and valid, and
  // capabilities / constraints / driver policy can't be changed at all.
  if (tctx.kind === PR_KIND) {
    const fixed = Object.keys(changes).filter(k => k !== 'inputs');
    if (fixed.length) {
      throw _fail(400, 'BAD_CHANGES', `A PR intent's scope is its PR — ${fixed.join(', ')} can't be revised (its capabilities stay ${PR_CAPABILITIES.join(', ')})`);
    }
    if ('inputs' in changes) changes.inputs = { pr: _prIntent(changes.inputs?.pr) };
  }

  const next = { ...tctx };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete next[k]; else next[k] = v;
  }
  const badInherit = inheritError(next.inputs);
  if (badInherit) throw _fail(400, 'BAD_INPUTS', badInherit);
  const changed = scopeChanged(tctx, next);
  // Nothing in the task changed — but what it inherits from its project may
  // have. Then revising with no changes is how it goes back for approval.
  if (!changed.length && tctx.approved?.scope_hash) {
    let stale;
    try { stale = scopeHash(await effectiveContext(ctx, task)) !== tctx.approved.scope_hash; }
    catch { stale = true; } // inherited scope no longer resolves (repository removed, task moved)
    if (stale) changed.push('inherited');
  }
  if (!changed.length) throw _fail(400, 'NO_CHANGE', 'changes leave the scope as it is');

  const from = tctx.state;
  const { approved, completed, ...rest } = next;
  const note = _note(payload.note);
  const revised = { by: _actor(ctx), at: new Date().toISOString(), changed, ...(note ? { note } : {}) };
  task.assign({ context: { ...rest, state: 'proposed' } });
  await task.save();

  await _recordEvent(ctx, {
    artifact_id: task.id, event_type: 'task.revised', event_name: 'Task revised',
    payload: { from, to: 'proposed', ...revised, previous: { approved: approved || null, completed: completed || null } },
  });

  packet._objects['task'] = task.data;
  packet.log.push(`task.revise → ${task.id} ${from} → proposed (${changed.join(', ')})`);
  return { data: { task: task.data, changed } };
}

// A PR intent is a task of kind 'pr': a change someone wants opened as a pull
// request, written down — not the change itself. inputs.pr says what the PR
// would be; the task title is its title. It requires repo.write, which no
// harness driver offers, and harness.run refuses it outright, so nothing can
// execute it. Approving one records the go-ahead; opening real PRs is a
// separate, later capability.
const PR_KIND = 'pr';
const PR_CAPABILITIES = Object.freeze(['repo.write']);
const PR_REF = /^[A-Za-z0-9._/-]{1,100}$/;
const PR_BODY_MAX = 20000;
const _text = v => typeof v === 'string' && v.trim().length > 0;
const _ref = v => _text(v) && PR_REF.test(v) && !v.includes('..') && !v.startsWith('/') && !v.endsWith('/');

function _prIntent(pr) {
  if (!_isObject(pr)) throw _fail(400, 'BAD_PR', 'pr must be an object');
  const repo = pr.repository;
  if (!_isObject(repo) || !_text(repo.alias) || !_text(repo.path)) throw _fail(400, 'BAD_PR', 'pr.repository needs an alias and a path');
  // Absolute and normalized here; containment (allowed roots) is for the
  // capability that eventually opens real PRs to check, at the time it acts.
  const repoPath = repo.path.trim();
  if (!path.isAbsolute(repoPath) || repoPath.includes('\0')) throw _fail(400, 'BAD_PR', 'pr.repository.path must be an absolute path');
  const base = pr.base ?? 'main';
  if (!_ref(base)) throw _fail(400, 'BAD_PR', `pr.base "${base}" is not a branch name`);
  if (pr.branch != null && !_ref(pr.branch)) throw _fail(400, 'BAD_PR', `pr.branch "${pr.branch}" is not a branch name`);
  if (pr.body != null && (typeof pr.body !== 'string' || pr.body.length > PR_BODY_MAX)) throw _fail(400, 'BAD_PR', `pr.body must be text of at most ${PR_BODY_MAX} characters`);
  return {
    repository: { alias: repo.alias.trim(), path: path.resolve(repoPath) },
    base,
    ...(pr.branch ? { branch: pr.branch } : {}),
    body: pr.body || '',
  };
}

const LIST_FIELDS = ['required_capabilities', 'acceptance_criteria'];

// payload: { title, description?, required_capabilities?, acceptance_criteria?, inputs?,
//            constraints?, execution_policy?, derived_from?, project_id?,
//            kind?, pr? }
// project_id puts the task in that project (an Ark), as event.create does.
// kind: 'pr' with pr: { repository: { alias, path }, base?, branch?, body? }
// makes a PR intent (see above): inputs and capabilities are set from pr.
async function propose(ctx, payload, packet) {
  const { title, description = '', derived_from = null, project_id = null } = payload;
  if (!title || !String(title).trim()) throw Object.assign(new Error('title is required'), { status: 400 });
  for (const f of LIST_FIELDS) {
    if (payload[f] != null && !Array.isArray(payload[f])) throw Object.assign(new Error(`${f} must be an array`), { status: 400 });
  }
  if (payload.kind != null && !_text(payload.kind)) throw _fail(400, 'BAD_KIND', 'kind must be a name');
  // Normalized once: the value checked is the value stored.
  const kind = payload.kind == null ? null : payload.kind.trim();
  const isPr = kind === PR_KIND;
  const inputs = isPr ? { pr: _prIntent(payload.pr) } : (payload.inputs ?? {});
  const required = isPr ? [...PR_CAPABILITIES] : (payload.required_capabilities || []);
  if (!_isObject(inputs)) throw _fail(400, 'BAD_INPUTS', 'inputs must be an object');
  const badInherit = inheritError(inputs);
  if (badInherit) throw _fail(400, 'BAD_INPUTS', badInherit);
  if (inputs.project_repositories != null && !project_id) {
    throw _fail(400, 'BAD_INPUTS', 'inputs.project_repositories needs a project_id to inherit from');
  }
  if (payload.constraints != null && !_isObject(payload.constraints)) throw _fail(400, 'BAD_CONSTRAINTS', 'constraints must be an object');
  const badPolicy = policyError(payload.execution_policy);
  if (badPolicy) throw _fail(400, 'BAD_POLICY', badPolicy);

  if (derived_from) {
    const source = await Artifact.findById(derived_from, ctx);
    if (!source) throw Object.assign(new Error('derived_from artifact not found'), { status: 404 });
  }
  let project = null;
  if (project_id) {
    project = await Artifact.findById(project_id, ctx);
    if (!project || project.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }

  const task = new Artifact({
    artifact_type: 'task',
    title: String(title).trim().slice(0, 200),
    body: String(description),
    summary: String(description).split('\n')[0].slice(0, 280),
    context: {
      visibility: 'private',
      state: 'proposed',
      ...(kind ? { kind } : {}),
      inputs,
      required_capabilities: required,
      acceptance_criteria: payload.acceptance_criteria || [],
      ...(payload.constraints && !isPr ? { constraints: payload.constraints } : {}),
      ...(payload.execution_policy && !isPr ? { execution_policy: payload.execution_policy } : {}),
      // Who proposed it: the actor, and the agent run when it was delegated.
      proposed_by: {
        actor: ctx.user_id || ctx.ark_actor_id || null,
        delegation: ctx.delegation || null,
      },
      derived_from,
    },
  }, { context: ctx });
  await task.save();

  if (derived_from) {
    await new ArtifactRelation({
      source_artifact_id: task.id,
      target_artifact_id: derived_from,
      relation_type: 'derived_from',
    }, { context: ctx }).save();
  }
  if (project) {
    const order_index = (await ArtifactRelation.maxOrderIndex(project.id, 'contains')) + 1;
    await new ArtifactRelation({ source_artifact_id: project.id, target_artifact_id: task.id, relation_type: 'contains', order_index }, { context: ctx }).save();
  }

  packet._objects['task'] = task.data;
  packet.log.push(`task.propose → ${task.id} "${task.get('title')}"${ctx.delegation ? ` (via ${ctx.delegation.via})` : ''}`);
  return { data: { task: task.data } };
}

// payload: { task_id } — read-only. The task's effective repositories
// (inherited ones resolved), and whether that scope still matches what was
// approved. stale: approved, but what it would read has changed since — it
// can't run until revised (task.revise with no changes) and approved again.
async function scope(ctx, payload, packet) {
  const task = await _loadTask(ctx, payload.task_id);
  const tctx = task.get('context') || {};
  let effective = null;
  let error = null;
  try { effective = await effectiveContext(ctx, task); }
  catch (err) { error = { code: err.code || 'SCOPE_ERROR', message: err.message }; }
  const pinned = tctx.approved?.scope_hash || null;
  const stale = !!pinned && (!effective || scopeHash(effective) !== pinned);
  packet.log.push(`task.scope → ${task.id}${stale ? ' (stale)' : ''}${error ? ` ${error.code}` : ''}`);
  return { data: {
    repositories: (effective || tctx).inputs?.repositories || [],
    inherits: tctx.inputs?.project_repositories ?? null,
    stale, error,
  } };
}

// ── task.history ────────────────────────────────────────────────────────────
// payload: { task_id, limit? (1–100, default 25), before? (next_before) }
//
// The task's timeline, newest first, from what was recorded — never
// reconstructed beyond it:
//   - the task itself (proposed: its creation)
//   - its events: lifecycle (task.approved/revised/completed), run outcomes
//     (task.run_*, ark#23) and anything else written on it
//   - runs that predate run events: a review it produced (attempts and cost
//     from the review; no ledger link) and a failed/cancelled last_attempt
//     no event covers. Each says so: evidence names the source and missing
//     lists what that source can't tell.
// summary covers every run, not just this page: counts by outcome and the
// usage totals (reported dollars and unpriced calls kept apart).
const HISTORY_EVENTS_MAX = 1000;
const RUN_OUTCOMES = ['succeeded', 'failed', 'cancelled'];
const _json = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {}));
// Timeline order, newest first: time, then the task's creation before
// anything recorded in the same instant, then id. The cursor is this key.
const _key = e => [String(e.at || ''), e.type === 'task.proposed' && e.evidence === 'artifact' ? 0 : 1, String(e.id)];
const _cmpKey = (x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] !== y[1] ? x[1] - y[1] : x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
// One timestamp format for ordering and cursors (Postgres and sqlite differ).
const _at = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

function _runEntry(id, at, outcome, d, evidence, missing = []) {
  return {
    id, at: _at(at), kind: 'run', type: `task.run_${outcome}`, actor: null, evidence, missing,
    run: {
      outcome, run_key: d.run_key || null, started_at: d.started_at || null, ended_at: d.ended_at || null,
      driver: d.driver || null, model: d.model || null, cached: !!d.cached,
      code: d.code || null, message: d.message || null, review_id: d.review_id || null, findings: d.findings ?? null,
      attempts: d.attempts || [], totals: d.totals || usage.summarize(d.attempts || [])?.totals || null,
      ledger_id: d.ledger_id || null, via: d.via || null, ark_calls: d.ark_calls ?? null,
    },
  };
}

// The whole timeline for one task, newest first, and its summary.
async function _timeline(ctx, task) {
  const tctx = task.get('context') || {};

  const { data: rows, error } = await Artifact.db.from('artifact_events').select('*')
    .eq('artifact_id', task.id).order('created_at', { ascending: false }).limit(HISTORY_EVENTS_MAX);
  if (error) throw new Error(error.message || 'Failed to load task events');

  const entries = [{
    id: `task:${task.id}`, at: _at(task.get('created_at')), kind: 'lifecycle', type: 'task.proposed',
    actor: task.get('created_by') || null, detail: { to: 'proposed' }, evidence: 'artifact', missing: [],
  }];
  const covered = { reviews: new Set(), runs: new Set() };
  for (const r of rows || []) {
    const p = _json(r.payload);
    const outcome = r.event_type.startsWith('task.run_') ? r.event_type.slice('task.run_'.length) : null;
    if (outcome && RUN_OUTCOMES.includes(outcome)) {
      if (p.review_id && !p.cached) covered.reviews.add(p.review_id);
      if (p.run_key) covered.runs.add(`${p.run_key}:${outcome}`);
      const e = _runEntry(r.id, r.created_at, outcome, p, 'event');
      e.actor = r.actor_id || null;
      entries.push(e);
    } else {
      entries.push({
        id: r.id, at: _at(r.created_at), kind: r.event_type.startsWith('task.') ? 'lifecycle' : 'event',
        type: r.event_type, name: r.event_name, actor: r.actor_id || null, detail: p, evidence: 'event', missing: [],
      });
    }
  }

  // Reviews produced before run events existed: real attempts, no ledger link.
  const { data: rels } = await Artifact.db.from('artifact_relations').select('target_artifact_id, created_at')
    .eq('source_artifact_id', task.id).eq('relation_type', 'produced');
  for (const rel of rels || []) {
    if (covered.reviews.has(rel.target_artifact_id)) continue;
    const review = await Artifact.findById(rel.target_artifact_id, ctx);
    if (!review || review.get('artifact_type') !== 'review') continue;
    const m = review.get('metadata') || {};
    covered.runs.add(`${m.run_key}:succeeded`);
    entries.push(_runEntry(`review:${review.id}`, m.ended_at || review.get('created_at'), 'succeeded', {
      run_key: m.run_key, started_at: m.started_at, ended_at: m.ended_at, driver: m.harness?.driver, model: m.model,
      review_id: review.id, findings: Array.isArray(m.findings) ? m.findings.length : null,
      attempts: (m.attempts || []).map(a => usage.fromHarness(a, a.ok ? m.model : null)),
      ark_calls: Array.isArray(m.ark_calls) ? m.ark_calls.length : null,
    }, 'review', ['ledger_id']));
  }

  // The latest run, when no event records it: in progress, or a failure /
  // cancel from before run events.
  const la = tctx.last_attempt;
  if (la?.status === 'running') {
    entries.push({ id: `last_attempt:${la.run_key}`, at: _at(la.started_at), kind: 'run', type: 'task.run_running', actor: null,
      evidence: 'last_attempt', missing: [], run: { outcome: 'running', run_key: la.run_key, started_at: la.started_at, attempts: [], totals: null } });
  } else if (la && RUN_OUTCOMES.includes(la.status) && la.status !== 'succeeded' && !covered.runs.has(`${la.run_key}:${la.status}`)) {
    const attempts = (la.attempts || []).map(a => usage.fromHarness(a));
    entries.push(_runEntry(`last_attempt:${la.run_key}`, la.ended_at || la.started_at, la.status, { ...la, attempts },
      'last_attempt', ['ledger_id', ...(attempts.length ? [] : ['attempts'])]));
  }

  entries.sort((a, b) => _cmpKey(_key(b), _key(a)));

  const runs = entries.filter(e => e.kind === 'run' && e.run.outcome !== 'running');
  const summary = {
    runs: Object.fromEntries([...RUN_OUTCOMES, 'cached'].map(o => [o, 0])),
    usage: usage.summarize(runs.flatMap(e => e.run.attempts))?.totals || null,
    runs_without_attempts: runs.filter(e => !e.run.cached && !e.run.attempts.length).length,
    ...(rows?.length === HISTORY_EVENTS_MAX ? { events_truncated: true } : {}),
  };
  for (const e of runs) summary.runs[e.run.cached ? 'cached' : e.run.outcome]++;
  return { entries, summary };
}

async function history(ctx, payload, packet) {
  const task = await _loadTask(ctx, payload.task_id);
  const limit = Math.min(Math.max(parseInt(payload.limit, 10) || 25, 1), 100);
  const { entries, summary } = await _timeline(ctx, task);

  // Cursor: the last entry's (at, id); strictly older entries follow.
  let page = entries;
  if (payload.before) {
    const [at, ord, ...rest] = String(payload.before).split('|');
    const cursor = [at, Number(ord), rest.join('|')];
    page = entries.filter(e => _cmpKey(_key(e), cursor) < 0);
  }
  const out = page.slice(0, limit);
  const next_before = page.length > limit ? _key(out[out.length - 1]).join('|') : null;

  packet.log.push(`task.history → ${task.id} (${out.length} of ${entries.length}${next_before ? ', more' : ''})`);
  return { data: { entries: out, next_before, summary } };
}

// ── task.usage ──────────────────────────────────────────────────────────────
// payload: { project_id }
// What the project's tasks have spent, from the same evidence as
// task.history: run outcomes by kind, usage totals (reported dollars and
// unpriced calls apart) and the same per provider. Only tasks the caller
// can see count. Agent runs only — direct LLM calls aren't tied to a
// project; their usage is on their own ledger rows.
const USAGE_TASKS_MAX = 200;

function _addTotals(into, t) {
  if (!t) return into;
  for (const [k, v] of Object.entries(t)) into[k] = (into[k] || 0) + (v || 0);
  into.usd_reported = Math.round(into.usd_reported * 1e6) / 1e6;
  return into;
}

async function usageOf(ctx, payload, packet) {
  const { project_id } = payload;
  if (!project_id) throw _fail(400, 'MISSING_PROJECT_ID', 'project_id is required');
  const project = await Artifact.findById(project_id, ctx);
  if (!project || project.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');

  const { data: rels, error } = await Artifact.db.from('artifact_relations').select('target_artifact_id')
    .eq('source_artifact_id', project_id).eq('relation_type', 'contains');
  if (error) throw new Error(error.message || 'Failed to load project members');

  const out = { tasks: 0, runs: { succeeded: 0, failed: 0, cancelled: 0, cached: 0 }, usage: null, by_provider: {}, runs_without_attempts: 0 };
  const ids = (rels || []).map(r => r.target_artifact_id);
  for (const id of ids) {
    if (out.tasks >= USAGE_TASKS_MAX) { out.tasks_truncated = true; break; }
    const task = await Artifact.findById(id, ctx);
    if (!task || task.get('artifact_type') !== 'task') continue;
    out.tasks++;
    const { entries, summary } = await _timeline(ctx, task);
    for (const [k, v] of Object.entries(summary.runs)) out.runs[k] += v;
    out.runs_without_attempts += summary.runs_without_attempts;
    if (summary.usage) out.usage = _addTotals(out.usage || {}, summary.usage);
    for (const e of entries) {
      if (e.kind !== 'run') continue;
      for (const a of e.run.attempts) {
        const key = a.provider || 'unknown';
        out.by_provider[key] = _addTotals(out.by_provider[key] || {}, usage.summarize([a]).totals);
      }
    }
  }
  packet.log.push(`task.usage → ${project_id} (${out.tasks} tasks)`);
  return { data: out };
}

module.exports = { propose, approve, complete, revise, scope, history, usage: usageOf, PR_KIND };
