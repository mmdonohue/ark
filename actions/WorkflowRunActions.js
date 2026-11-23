'use strict';

// WorkflowRunActions — launching a project workflow and walking its steps.
//
//   artifact_type: 'workflow_run', contained by the project
//   context: {
//     state: 'proposed' | 'running' | 'completed' | 'cancelled',
//     definition: { alias, revision, from, template?, title, inputs, steps },  // snapshot at launch
//     steps: [{ key, state, task_id, blocked? }],
//     launched: { by, at, note? },
//     approved: { by, at, note?, plan_hash, step_scopes: { <ai step key>: scope_hash } },
//   }
//   run —[has_step order_index]→ step task;  project —[contains]→ step task
//
// Approval happens once, at workflow.approve: it pins the definition
// snapshot and the effective scope of every ai step. Steps then become
// governed tasks one at a time, as the run reaches them:
//   - not gated → approved on the run's approval (approved.via names the
//     run). An ai step whose scope no longer matches what was pinned (the
//     project's repositories changed) is left proposed for a person instead.
//   - gated → proposed; it waits for its own task.approve.
//   - kind 'pr' → waits for someone to propose the PR intent into the step
//     (task.propose with workflow_step), then for its approval.
//   - automated → its action runs right away through dispatch(), as whoever
//     advanced the run, and the step resolves with the result as evidence.
// A step resolves through task.complete; an ai step also resolves when its
// harness run succeeds (the review is the evidence). Each resolution moves
// the run on. workflow.advance re-checks a run (after a failure, say) and is
// safe to repeat.

const crypto = require('crypto');
const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');
const { effectiveWorkflows } = require('./WorkflowDefinitionActions');
const { resolveInherited } = require('./RepositoryActions');
const { scopeHash } = require('../utils/taskScope');
const { withLock } = require('../utils/keyedLock');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const json = v => (typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}));
const _actor = ctx => ctx.user_id || ctx.ark_actor_id || null;
const _note = n => (n == null ? null : String(n).trim().slice(0, 2000) || null);
const _locked = (run_id, fn) => withLock(`workflow.run:${run_id}`, fn);

function _canonical(v) {
  if (Array.isArray(v)) return v.map(_canonical);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => (v[k] === undefined ? o : { ...o, [k]: _canonical(v[k]) }), {});
  return v ?? null;
}
const planHash = def => crypto.createHash('sha256').update(JSON.stringify(_canonical(def))).digest('hex');

async function _project(ctx, project_id) {
  if (!project_id) throw _fail(400, 'MISSING_PROJECT_ID', 'project_id is required');
  const ark = await Artifact.findById(project_id, ctx);
  if (!ark || ark.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
  return ark;
}

async function _run(ctx, run_id) {
  if (!run_id) throw _fail(400, 'MISSING_RUN_ID', 'run_id is required');
  const run = await Artifact.findById(run_id, ctx);
  if (!run || run.get('artifact_type') !== 'workflow_run') throw _fail(404, 'RUN_NOT_FOUND', 'Workflow run not found');
  return run;
}

async function _runProject(run) {
  const { data } = await Artifact.db.from('artifact_relations').select('source_artifact_id')
    .eq('target_artifact_id', run.id).eq('relation_type', 'contains');
  return data?.[0]?.source_artifact_id || null;
}

async function _save(run, rctx) {
  run.assign({ context: rctx });
  await run.save();
}

// The governed-task context a step becomes (before repositories resolve).
function stepTaskContext(def, step) {
  if (step.mode !== 'ai') return { inputs: {}, required_capabilities: [] };
  return {
    inputs: { project_repositories: def.inputs?.project_repositories ?? 'all' },
    required_capabilities: step.required_capabilities || ['repo.read'],
    ...(step.execution_policy ? { execution_policy: step.execution_policy } : {}),
  };
}

// ── launch / approve / cancel ───────────────────────────────────────────────

// payload: { project_id, alias, note? }
async function launch(ctx, payload, packet) {
  const project = await _project(ctx, payload.project_id);
  const def = (await effectiveWorkflows(ctx, project)).find(w => w.alias === payload.alias);
  if (!def) throw _fail(404, 'WORKFLOW_NOT_FOUND', `Project has no workflow "${payload.alias}"`);
  if (def.error) throw _fail(422, 'BAD_WORKFLOW', `Workflow "${def.alias}" is invalid: ${def.error}`);

  const definition = {
    alias: def.alias, revision: def.revision, from: def.from, ...(def.template ? { template: def.template } : {}),
    title: def.title, inputs: def.inputs, steps: def.steps,
  };
  const note = _note(payload.note);
  const run = new Artifact({
    artifact_type: 'workflow_run',
    title: `${def.title} (r${def.revision})`,
    summary: `${def.steps.length} steps`,
    status: 'published',
    context: {
      visibility: 'private', state: 'proposed', definition,
      steps: def.steps.map(s => ({ key: s.key, state: 'pending', task_id: null })),
      launched: { by: _actor(ctx), at: new Date().toISOString(), ...(note ? { note } : {}) },
    },
  }, { context: ctx });
  await run.save();
  const order_index = (await ArtifactRelation.maxOrderIndex(project.id, 'contains')) + 1;
  await new ArtifactRelation({ source_artifact_id: project.id, target_artifact_id: run.id, relation_type: 'contains', order_index }, { context: ctx }).save();
  await _recordEvent(ctx, { artifact_id: run.id, event_type: 'workflow.launched', event_name: 'Workflow launched',
    payload: { project_id: project.id, alias: def.alias, revision: def.revision, from: def.from, ...(note ? { note } : {}) } });

  packet._objects['run'] = run.data;
  packet.log.push(`workflow.launch → ${def.alias} r${def.revision} → run ${run.id} (proposed)`);
  return { data: { run: run.data } };
}

// payload: { run_id, note? }
function approve(ctx, payload, packet) {
  return _locked(payload.run_id, async () => {
    const run = await _run(ctx, payload.run_id);
    const rctx = json(run.get('context'));
    if (rctx.state !== 'proposed') throw _fail(409, 'RUN_NOT_PROPOSED', `Run is ${rctx.state}; only a proposed run can be approved`);
    const project_id = await _runProject(run);
    if (!project_id) throw _fail(409, 'PROJECT_AMBIGUOUS', 'Run is not in a project');

    // Pin what each ai step will read, resolved now.
    const step_scopes = {};
    for (const s of rctx.definition.steps.filter(x => x.mode === 'ai')) {
      step_scopes[s.key] = scopeHash(await resolveInherited(ctx, project_id, stepTaskContext(rctx.definition, s)));
    }
    const note = _note(payload.note);
    const approved = { by: _actor(ctx), at: new Date().toISOString(), plan_hash: planHash(rctx.definition), step_scopes, ...(note ? { note } : {}) };
    const next = { ...rctx, state: 'running', approved };
    await _save(run, next);
    await _recordEvent(ctx, { artifact_id: run.id, event_type: 'workflow.approved', event_name: 'Run approved',
      payload: { plan_hash: approved.plan_hash, steps: Object.keys(step_scopes), ...(note ? { note } : {}) } });
    packet.log.push(`workflow.approve → run ${run.id} proposed → running`);

    await _advance(ctx, run, project_id, packet);
    return { data: await _view(ctx, run) };
  });
}

// payload: { run_id, note? }
function cancel(ctx, payload, packet) {
  return _locked(payload.run_id, async () => {
    const run = await _run(ctx, payload.run_id);
    const rctx = json(run.get('context'));
    if (!['proposed', 'running'].includes(rctx.state)) throw _fail(409, 'RUN_FINISHED', `Run is already ${rctx.state}`);
    const note = _note(payload.note);
    await _save(run, { ...rctx, state: 'cancelled', cancelled: { by: _actor(ctx), at: new Date().toISOString(), ...(note ? { note } : {}) } });
    await _recordEvent(ctx, { artifact_id: run.id, event_type: 'workflow.cancelled', event_name: 'Run cancelled', payload: { from: rctx.state, ...(note ? { note } : {}) } });
    packet.log.push(`workflow.cancel → run ${run.id}`);
    return { data: await _view(ctx, run) };
  });
}

// payload: { run_id } — re-check and move on; safe to repeat.
function advance(ctx, payload, packet) {
  return _locked(payload.run_id, async () => {
    const run = await _run(ctx, payload.run_id);
    const project_id = await _runProject(run);
    await _advance(ctx, run, project_id, packet);
    return { data: await _view(ctx, run) };
  });
}

// payload: { run_id } — the run and each step with its task's state.
async function inspect(ctx, payload, packet) {
  const run = await _run(ctx, payload.run_id);
  packet.log.push(`workflow.inspect → run ${run.id}`);
  return { data: await _view(ctx, run) };
}

async function _view(ctx, run) {
  const fresh = await Artifact.findById(run.id, ctx);
  const rctx = json(fresh.get('context'));
  const steps = [];
  for (const [i, s] of rctx.steps.entries()) {
    const def = rctx.definition.steps[i];
    const task = s.task_id ? await Artifact.findById(s.task_id, ctx) : null;
    const tctx = task ? json(task.get('context')) : null;
    steps.push({
      ...s, title: def.title, mode: def.mode, gate: !!def.gate, ...(def.kind ? { kind: def.kind } : {}),
      task: task ? { id: task.id, title: task.get('title'), state: tctx.state, last_attempt: tctx.last_attempt?.status || null } : null,
    });
  }
  return { run: fresh.data, steps };
}

// ── walking the steps ───────────────────────────────────────────────────────

const STEP_EVENT = (ctx, run, type, name, payload) => _recordEvent(ctx, { artifact_id: run.id, event_type: type, event_name: name, payload });

// Moves a running run as far as it can go. Caller holds the run's lock.
async function _advance(ctx, run, project_id, packet) {
  for (let guard = 0; guard < 50; guard++) {
    const rctx = json((await Artifact.findById(run.id, ctx)).get('context'));
    if (rctx.state !== 'running') return;
    const i = rctx.steps.findIndex(s => s.state !== 'resolved');
    if (i === -1) {
      await _save(run, { ...rctx, state: 'completed', completed_at: new Date().toISOString() });
      await STEP_EVENT(ctx, run, 'workflow.completed', 'Run completed', { steps: rctx.steps.length });
      packet.log.push(`workflow → run ${run.id} completed`);
      return;
    }
    const step = rctx.steps[i];
    const def = rctx.definition.steps[i];
    const setStep = async patch => {
      const steps = rctx.steps.map((s, j) => (j === i ? { ...s, ...patch } : s));
      await _save(run, { ...rctx, steps });
      rctx.steps = steps;
    };

    if (!step.task_id) {
      if (def.kind === 'pr') {
        if (step.state !== 'awaiting_input') {
          await setStep({ state: 'awaiting_input' });
          await STEP_EVENT(ctx, run, 'workflow.step_waiting', `Waiting for a PR intent: ${def.title}`, { step: def.key, waiting_for: 'pr_intent' });
        }
        return;
      }
      const task = await _materialize(ctx, run, rctx, def, i, project_id, packet);
      const tctx = json(task.get('context'));
      await setStep({ task_id: task.id, state: tctx.state, ...(tctx.workflow_run.blocked ? { blocked: tctx.workflow_run.blocked } : {}) });
      continue;
    }

    const task = await Artifact.findById(step.task_id, ctx);
    if (!task) { await setStep({ state: 'missing' }); return; }
    const tctx = json(task.get('context'));
    if (tctx.state === 'resolved') {
      await setStep({ state: 'resolved', blocked: undefined, error: undefined });
      await STEP_EVENT(ctx, run, 'workflow.step_resolved', `Step resolved: ${def.title}`, { step: def.key, task_id: task.id });
      continue;
    }
    if (step.state !== tctx.state) await setStep({ state: tctx.state });
    if (def.mode === 'automated' && tctx.state === 'ready') {
      const ok = await _runAutomated(ctx, run, def, task, packet);
      if (!ok) { await setStep({ error: tctx.workflow_run?.error || 'automated step failed' }); return; }
      continue;
    }
    return; // waiting on a person or an agent run
  }
}

// Creates the step's governed task in the project, linked to the run.
async function _materialize(ctx, run, rctx, def, i, project_id, packet) {
  const TaskActions = require('./TaskActions');
  const tctx0 = stepTaskContext(rctx.definition, def);
  const { data: { task: created } } = await TaskActions.propose(ctx, {
    project_id, title: def.title, description: def.body || '',
    inputs: tctx0.inputs, required_capabilities: tctx0.required_capabilities,
    ...(tctx0.execution_policy ? { execution_policy: tctx0.execution_policy } : {}),
    acceptance_criteria: def.acceptance_criteria || [],
  }, packet);
  await new ArtifactRelation({ source_artifact_id: run.id, target_artifact_id: created.id, relation_type: 'has_step', order_index: i }, { context: ctx }).save();

  const task = await Artifact.findById(created.id, ctx);
  const link = { run_id: run.id, step: def.key, mode: def.mode, gate: !!def.gate };
  let tctx = { ...json(task.get('context')), workflow_run: link };

  if (!def.gate) {
    const hash = scopeHash(await resolveInherited(ctx, project_id, tctx));
    const pinned = def.mode === 'ai' ? rctx.approved.step_scopes?.[def.key] : hash;
    if (pinned === hash) {
      const approved = { by: rctx.approved.by, at: new Date().toISOString(), scope_hash: hash, via: { workflow_run: run.id } };
      tctx = { ...tctx, state: 'ready', approved };
      await _recordEvent(ctx, { artifact_id: task.id, event_type: 'task.approved', event_name: 'Task approved (workflow run)',
        payload: { from: 'proposed', to: 'ready', ...approved } });
    } else {
      // The project's repositories changed since the run was approved: a
      // person approves the new scope.
      tctx = { ...tctx, workflow_run: { ...link, blocked: 'scope_changed' } };
      await STEP_EVENT(ctx, run, 'workflow.step_blocked', `Scope changed: ${def.title}`, { step: def.key, task_id: task.id, reason: 'scope_changed' });
    }
  }
  const fresh = await Artifact.findById(created.id, ctx);
  fresh.assign({ context: tctx });
  await fresh.save();
  await STEP_EVENT(ctx, run, 'workflow.step_started', `Step started: ${def.title}`, { step: def.key, task_id: task.id, state: tctx.state, mode: def.mode });
  packet.log.push(`workflow → run ${run.id} step ${def.key} → task ${task.id} (${tctx.state})`);
  return fresh;
}

// Runs an automated step's action as the current actor, then resolves it.
async function _runAutomated(ctx, run, def, task, packet) {
  const { dispatch } = require('../core/dispatch');
  const childCtx = {
    user_id: ctx.user_id, store_id: ctx.store_id, role: ctx.role, rank: ctx.rank, ark_actor_id: ctx.ark_actor_id,
    delegation: { via: 'workflow', run_id: run.id, step: def.key }, source: 'workflow',
  };
  try {
    const r = await dispatch({ action: def.action, payload: def.payload || {}, meta: { parent_request_id: ctx.request_id || null, workflow_run: run.id, step: def.key } }, childCtx);
    await _resolve(ctx, task, { note: `automated: ${def.action}`, result: { action: def.action, ledger_id: r.meta?.ledger_id || null } });
    packet.log.push(`workflow → run ${run.id} step ${def.key} ran ${def.action}`);
    return true;
  } catch (err) {
    const t = await Artifact.findById(task.id, ctx);
    const tctx = json(t.get('context'));
    t.assign({ context: { ...tctx, workflow_run: { ...tctx.workflow_run, error: `${err.code || 'ERROR'}: ${err.message}`.slice(0, 500) } } });
    await t.save();
    await STEP_EVENT(ctx, run, 'workflow.step_failed', `Step failed: ${def.title}`, { step: def.key, task_id: task.id, code: err.code || null, message: String(err.message).slice(0, 500) });
    packet.log.push(`workflow → run ${run.id} step ${def.key} failed: ${err.message}`);
    return false;
  }
}

// ready → resolved, as task.complete records it, for steps the run resolves itself.
async function _resolve(ctx, task, { note, artifacts = [], result } = {}) {
  const t = await Artifact.findById(task.id, ctx);
  const tctx = json(t.get('context'));
  if (tctx.state !== 'ready') return false;
  const completed = { by: _actor(ctx), at: new Date().toISOString(), via: { workflow_run: tctx.workflow_run?.run_id || null },
    evidence: { note, artifacts, ...(result ? { result } : {}) } };
  t.assign({ context: { ...tctx, state: 'resolved', completed } });
  await t.save();
  for (const id of artifacts) {
    await new ArtifactRelation({ source_artifact_id: t.id, target_artifact_id: id, relation_type: 'evidence' }, { context: ctx }).save();
  }
  await _recordEvent(ctx, { artifact_id: t.id, event_type: 'task.completed', event_name: 'Task completed', payload: { from: 'ready', to: 'resolved', ...completed } });
  return true;
}

// ── hooks from the task lifecycle and the harness ───────────────────────────

// A step task was completed (task.complete): move its run on. Never undoes
// the completion — a failure here is logged and workflow.advance retries.
async function onTaskResolved(ctx, task, packet) {
  const link = json(task.get('context')).workflow_run;
  if (!link?.run_id) return;
  try {
    await advance(ctx, { run_id: link.run_id }, packet);
  } catch (err) {
    packet.log.push(`workflow → run ${link.run_id} not advanced: ${err.message} (workflow.advance retries)`);
  }
}

// An ai step's harness run succeeded: the review resolves the step.
async function onReviewSucceeded(ctx, task_id, review_id, packet) {
  try {
    const task = await Artifact.findById(task_id, ctx);
    const link = json(task?.get('context')).workflow_run;
    if (!link?.run_id || link.mode !== 'ai') return;
    if (await _resolve(ctx, task, { note: 'ai step: review succeeded', artifacts: [review_id] })) {
      await advance(ctx, { run_id: link.run_id }, packet);
    }
  } catch (err) {
    packet.log.push(`workflow → step for task ${task_id} not resolved: ${err.message} (workflow.advance retries)`);
  }
}

// task.propose with workflow_step: { run_id, step } — a PR intent proposed
// into a waiting kind-'pr' step. Called after the task exists.
function attachPrIntent(ctx, task, ref, packet) {
  return _locked(ref?.run_id, async () => {
    const run = await _run(ctx, ref.run_id);
    const rctx = json(run.get('context'));
    if (rctx.state !== 'running') throw _fail(409, 'RUN_NOT_RUNNING', `Run is ${rctx.state}`);
    const i = rctx.steps.findIndex(s => s.key === ref.step);
    const def = rctx.definition.steps[i];
    if (i === -1 || def.kind !== 'pr') throw _fail(400, 'BAD_STEP', `Run has no PR step "${ref.step}"`);
    if (rctx.steps[i].state !== 'awaiting_input' || rctx.steps[i].task_id) throw _fail(409, 'STEP_NOT_WAITING', `Step "${ref.step}" isn't waiting for a PR intent`);

    const t = await Artifact.findById(task.id, ctx);
    t.assign({ context: { ...json(t.get('context')), workflow_run: { run_id: run.id, step: def.key, mode: def.mode, gate: true } } });
    await t.save();
    await new ArtifactRelation({ source_artifact_id: run.id, target_artifact_id: task.id, relation_type: 'has_step', order_index: i }, { context: ctx }).save();
    const steps = rctx.steps.map((s, j) => (j === i ? { ...s, task_id: task.id, state: 'proposed' } : s));
    await _save(run, { ...rctx, steps });
    await STEP_EVENT(ctx, run, 'workflow.step_started', `Step started: ${def.title}`, { step: def.key, task_id: task.id, state: 'proposed', mode: def.mode });
    packet.log.push(`workflow → run ${run.id} step ${def.key} ← PR intent ${task.id}`);
  });
}

module.exports = { launch, approve, cancel, advance, inspect, onTaskResolved, onReviewSucceeded, attachPrIntent, _internals: { planHash, stepTaskContext } };
