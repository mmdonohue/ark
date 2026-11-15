'use strict';

// TaskActions — creating task intent without authorizing it.
//
// task.propose writes an artifact_type 'task' whose state is always
// 'proposed', whatever the caller asks for. A proposal can't run:
// harness.run refuses it until someone with authority changes its state to
// 'ready' (task.approve). That keeps "an agent suggested this work" and
// "this work was approved" as two distinct, separately ledgered acts.
//
// Lifecycle, owned by these actions only (artifact.update refuses to touch
// state/approved/completed on a task):
//
//   proposed ──task.approve──▶ ready ──task.complete──▶ resolved
//
// Approving and completing are an admin's acts — rank 100 (a Seravanna
// ADMIN, or a local vessel's owner), see TraceActions.RANK_REQUIRED.

const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');

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

  const note = _note(payload.note);
  const approved = { by: _actor(ctx), at: new Date().toISOString(), ...(note ? { note } : {}) };
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

const LIST_FIELDS = ['required_capabilities', 'acceptance_criteria'];

// payload: { title, description?, required_capabilities?, acceptance_criteria?, inputs?, derived_from? }
async function propose(ctx, payload, packet) {
  const { title, description = '', inputs = {}, derived_from = null } = payload;
  if (!title || !String(title).trim()) throw Object.assign(new Error('title is required'), { status: 400 });
  for (const f of LIST_FIELDS) {
    if (payload[f] != null && !Array.isArray(payload[f])) throw Object.assign(new Error(`${f} must be an array`), { status: 400 });
  }

  if (derived_from) {
    const source = await Artifact.findById(derived_from, ctx);
    if (!source) throw Object.assign(new Error('derived_from artifact not found'), { status: 404 });
  }

  const task = new Artifact({
    artifact_type: 'task',
    title: String(title).trim().slice(0, 200),
    body: String(description),
    summary: String(description).split('\n')[0].slice(0, 280),
    context: {
      visibility: 'private',
      state: 'proposed',
      inputs,
      required_capabilities: payload.required_capabilities || [],
      acceptance_criteria: payload.acceptance_criteria || [],
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

  packet._objects['task'] = task.data;
  packet.log.push(`task.propose → ${task.id} "${task.get('title')}"${ctx.delegation ? ` (via ${ctx.delegation.via})` : ''}`);
  return { data: { task: task.data } };
}

module.exports = { propose, approve, complete };
