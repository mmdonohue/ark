'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');
const { scopeHash } = require('../utils/taskScope');
const workspaceScope = require('../utils/workspaceScope');
const worktree = require('../utils/worktree');
const vesselMode = require('../utils/vesselMode');

const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const actor = ctx => ctx.user_id || ctx.ark_actor_id || null;

function owner(ctx) {
  if (!ctx.store_id || !vesselMode.isForegroundOwner(ctx)) {
    throw fail('OWNER_ONLY', 'Workspace operations require an identified vessel and a foreground owner', 403);
  }
}

function idFor(store, task, attempt) {
  const b = crypto.createHash('sha256').update(JSON.stringify(['ark:workspace', store, task, attempt])).digest();
  b[6] = (b[6] & 15) | 0x80;
  b[8] = (b[8] & 63) | 0x80;
  const s = b.subarray(0, 16).toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function load(ctx, id) {
  const a = await Artifact.findById(id, ctx);
  if (!a || a.get('artifact_type') !== 'workspace' || a.get('inactive')) throw fail('WORKSPACE_NOT_FOUND', 'Workspace not found', 404);
  return a;
}

function checkedLocation(c, id) {
  if (c.id !== id || !/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.id || '')) {
    throw fail('WORKSPACE_MISMATCH', 'Workspace identity is invalid');
  }
  const loc = worktree.resolveRepository(c.repository_path);
  if (['repo', 'common', 'root', 'repo_identity', 'common_identity', 'root_identity'].some(k => loc[k] !== c[k])
      || c.path !== path.join(loc.root, c.id)
      || c.branch !== `ark/task-${c.id.replace(/-/g, '')}`) {
    throw fail('WORKSPACE_MISMATCH', 'The configured repository or workspace identity changed');
  }
  return loc;
}

async function event(ctx, a, type, detail = {}) {
  await _recordEvent(ctx, { artifact_id: a.id, event_type: `workspace.${type}`, event_name: `Workspace ${type}`,
    related_artifact_id: a.get('context').task_id, payload: detail });
}

async function save(a, patch) {
  a.assign({ context: { ...a.get('context'), ...patch } });
  await a.save();
}

async function link(ctx, taskId, workspaceId) {
  const { data, error } = await Artifact.db.from('artifact_relations').select('id')
    .eq('source_artifact_id', taskId).eq('target_artifact_id', workspaceId).eq('relation_type', 'produced');
  if (error) throw new Error(`Workspace relation lookup failed: ${error.message}`);
  if (!data?.length) {
    await new ArtifactRelation({ source_artifact_id: taskId, target_artifact_id: workspaceId, relation_type: 'produced' }, { context: ctx }).save();
  }
}

async function approved(ctx, taskId) {
  const task = await Artifact.findById(taskId, ctx);
  if (!task || task.get('artifact_type') !== 'task') throw fail('TASK_NOT_FOUND', 'Task not found', 404);
  const t = task.get('context') || {};
  if (t.state !== 'ready' || !t.approved?.scope_hash || !t.approved.workspace_intent_hash || t.approved.via) {
    throw fail('TASK_NOT_APPROVED', 'An explicitly owner-approved workspace task is required');
  }
  await require('./WorkflowRunActions').assertStepRunnable(ctx, t);
  const { effective, workspace, project_id } = await workspaceScope.resolve(ctx, task);
  if (scopeHash(effective) !== t.approved.scope_hash || workspaceScope.intentHash(task) !== t.approved.workspace_intent_hash) {
    throw fail('TASK_SCOPE_CHANGED', 'The approved workspace scope or task intent changed');
  }
  const loc = worktree.resolveRepository(workspace.path);
  if (['repo', 'common', 'root', 'repo_identity', 'common_identity', 'root_identity'].some(k => loc[k] !== t.approved.workspace_location?.[k])) {
    throw fail('TASK_SCOPE_CHANGED', 'The repository or workspace root changed since approval');
  }
  worktree.verifyBase(loc.repo, workspace.base_sha);
  return { task, effective, workspace, project_id, loc };
}

async function provision(ctx, payload, packet) {
  owner(ctx);
  const attempt = payload.attempt;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000000) throw fail('BAD_ATTEMPT', 'attempt must be an integer from 1 to 1000000', 400);
  const resolved = await approved(ctx, payload.task_id);
  const { task, workspace, project_id, loc } = resolved;
  const id = idFor(ctx.store_id, task.id, attempt);
  const info = {
    id, task_id: task.id, project_id, repository_id: workspace.repository_id,
    repository_path: workspace.path, base_sha: workspace.base_sha, attempt,
    ...loc, path: path.join(loc.root, id), branch: `ark/task-${id.replace(/-/g, '')}`,
    mode: 'implementation_worktree', scope_hash: resolved.effective.approved.scope_hash,
    intent_hash: resolved.effective.approved.workspace_intent_hash,
  };
  return worktree.withRepoLock(loc.common, async () => {
    await approved(ctx, task.id);
    let a = await Artifact.findById(id, ctx);
    if (a) {
      if (a.get('artifact_type') !== 'workspace') throw fail('WORKSPACE_MISMATCH', 'Workspace identity is occupied');
      const current = a.get('context');
      for (const [k, v] of Object.entries(info)) {
        if (current[k] !== v) throw fail('WORKSPACE_MISMATCH', `Workspace ${k} no longer matches the approved attempt`);
      }
      if (current.state === 'ready') {
        const observed = worktree.inspect(current);
        if (!observed.exists) throw fail('WORKSPACE_MISMATCH', 'The recorded worktree is missing; recover it first');
        return { data: { workspace: a.data, observed, cached: true } };
      }
      if (!['provisioning', 'failed'].includes(current.state)) throw fail('WORKSPACE_STATE', `Workspace is ${current.state}`);
    } else {
      a = new Artifact({ artifact_type: 'workspace', title: `Workspace: ${task.get('title')}`, status: 'published',
        context: { visibility: 'private', ...info, state: 'provisioning', created_by: actor(ctx), started_at: new Date().toISOString() } }, { context: ctx });
      await a.prepare();
      await a.authorize('Artifact.save');
      const { data, error } = await Artifact.db.from('artifacts').insert({ ...a.data, id }).select('*').single();
      if (error) throw new Error(`Workspace claim failed: ${error.message}`);
      a = new Artifact(data, { context: ctx });
      await event(ctx, a, 'provisioning', { task_id: task.id, attempt, base_sha: workspace.base_sha });
    }
    await link(ctx, task.id, id);
    const seen = worktree.inspect(info);
    if (seen.exists || seen.branch_sha || fs.existsSync(info.path)) {
      throw fail('WORKSPACE_COLLISION', 'Workspace path or branch already exists; use workspace.recover');
    }
    await save(a, { state: 'provisioning', error: null });
    try {
      worktree.git(info.repo, ['worktree', 'add', '-b', info.branch, '--', info.path, info.base_sha]);
      const observed = worktree.inspect(info);
      if (!observed.exists || observed.head !== info.base_sha || observed.dirty) throw fail('WORKSPACE_MISMATCH', 'New workspace did not match its approved base');
      await save(a, { state: 'ready', creation_confirmed: true, ready_at: new Date().toISOString() });
      await event(ctx, a, 'ready', { base_sha: info.base_sha, branch: info.branch });
      packet.log.push(`workspace.provision → ${id}`);
      return { data: { workspace: a.data, observed, cached: false } };
    } catch (err) {
      await save(a, { state: 'failed', error: { code: err.code || 'ERROR', message: err.message } });
      await event(ctx, a, 'failed', { code: err.code || 'ERROR', message: err.message });
      throw err;
    }
  });
}

async function list(ctx, payload) {
  owner(ctx);
  const filters = payload.task_id ? [['context->>task_id', 'eq', payload.task_id]] : [];
  return { data: { workspaces: await Artifact.query({ artifact_type: 'workspace', filters, limit: 100 }, ctx) } };
}

async function status(ctx, payload) {
  owner(ctx);
  const a = await load(ctx, payload.workspace_id);
  const c = a.get('context');
  checkedLocation(c, a.id);
  return { data: { workspace: a.data, observed: worktree.inspect(c) } };
}

async function recover(ctx, payload, packet) {
  owner(ctx);
  const a = await load(ctx, payload.workspace_id);
  const c = a.get('context');
  checkedLocation(c, a.id);
  return worktree.withRepoLock(c.common, async () => {
    const fresh = await load(ctx, a.id);
    const current = fresh.get('context');
    checkedLocation(current, fresh.id);
    const observed = worktree.inspect(current);
    let state;
    if (observed.exists) {
      state = current.creation_confirmed && current.state !== 'cleaned'
        && observed.head === current.base_sha && !observed.dirty ? 'ready' : 'preserved';
    } else if (current.state === 'cleaning' && observed.branch_sha === current.base_sha) {
      state = 'cleaned';
    } else if (!observed.branch_sha) {
      state = 'failed';
    } else {
      state = 'preserved';
    }
    await link(ctx, current.task_id, fresh.id);
    await save(fresh, { state, recovered_at: new Date().toISOString() });
    await event(ctx, fresh, 'recovered', { from: current.state, to: state, observed });
    packet.log.push(`workspace.recover → ${fresh.id}: ${state}`);
    return { data: { workspace: fresh.data, observed } };
  }, { recover: true });
}

async function cleanup(ctx, payload, packet) {
  owner(ctx);
  if (payload.confirm_no_pr_or_active_processes !== true) {
    throw fail('CLEANUP_CONFIRMATION_REQUIRED', 'Confirm there is no linked PR or active process before cleanup', 400);
  }
  const a = await load(ctx, payload.workspace_id);
  const c = a.get('context');
  checkedLocation(c, a.id);
  return worktree.withRepoLock(c.common, async () => {
    const fresh = await load(ctx, a.id);
    const current = fresh.get('context');
    checkedLocation(current, fresh.id);
    if (!['ready', 'preserved'].includes(current.state) || !current.creation_confirmed) {
      throw fail('WORKSPACE_STATE', `Workspace is ${current.state} or its creation is unconfirmed; preserve and inspect it manually`);
    }
    const observed = worktree.inspect(current);
    if (!observed.exists || observed.dirty || observed.head !== current.base_sha || observed.branch_sha !== current.base_sha || observed.remote_refs.length) {
      throw fail('WORKSPACE_PRESERVED', 'Workspace is missing, dirty, contains commits, or has a remote branch; it will not be removed');
    }
    await save(fresh, { state: 'cleaning', cleanup_by: actor(ctx) });
    await event(ctx, fresh, 'cleaning', { confirmed_no_pr_or_active_processes: true });
    worktree.git(current.repo, ['worktree', 'remove', '--', current.path]);
    await save(fresh, { state: 'cleaned', cleaned_at: new Date().toISOString() });
    await event(ctx, fresh, 'cleaned', { branch_preserved: current.branch });
    packet.log.push(`workspace.cleanup → ${fresh.id}`);
    return { data: { workspace: fresh.data } };
  });
}

module.exports = { provision, list, status, recover, cleanup };
