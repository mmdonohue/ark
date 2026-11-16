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

const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');
const { SCOPE_KEYS, scopeHash, scopeChanged, policyError } = require('../utils/taskScope');

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
  const approved = { by: _actor(ctx), at: new Date().toISOString(), scope_hash: scopeHash(tctx), ...(note ? { note } : {}) };
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
  // A PR intent's inputs are its PR; they stay a valid one.
  if (tctx.kind === PR_KIND && 'inputs' in changes) changes.inputs = { ...(changes.inputs || {}), pr: _prIntent(changes.inputs?.pr) };

  const next = { ...tctx };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete next[k]; else next[k] = v;
  }
  const changed = scopeChanged(tctx, next);
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
  const base = pr.base ?? 'main';
  if (!_ref(base)) throw _fail(400, 'BAD_PR', `pr.base "${base}" is not a branch name`);
  if (pr.branch != null && !_ref(pr.branch)) throw _fail(400, 'BAD_PR', `pr.branch "${pr.branch}" is not a branch name`);
  if (pr.body != null && (typeof pr.body !== 'string' || pr.body.length > PR_BODY_MAX)) throw _fail(400, 'BAD_PR', `pr.body must be text of at most ${PR_BODY_MAX} characters`);
  return {
    repository: { alias: repo.alias.trim(), path: repo.path.trim() },
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

module.exports = { propose, approve, complete, revise, PR_KIND };
