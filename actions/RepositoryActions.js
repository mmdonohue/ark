'use strict';

// RepositoryActions — a project's repositories, as artifacts it contains.
//
//   artifact_type: 'repository'
//   context: { alias, path, default_branch, remote? }
//   project —[contains]→ repository
//
// Tasks inherit them by opting in (inputs.project_repositories: 'all' or
// [alias]); effectiveContext() resolves that. Approval pins the hash of the
// *effective* scope, so changing a project's repositories can't change what
// an approved task reads: the task refuses to run until it is sent back
// (task.revise) and approved again.
//
// The alias is a repository's identity — tasks name it — so it can't be
// renamed; remove and add instead. Adding, updating and removing are an
// admin's acts (repository.write, rank 100).

const path = require('path');
const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const _isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = v => (typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}));

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const REMOTE = /^[A-Za-z0-9._@:/~+-]{1,300}$/;
const MAX_REPOS = 50;

const _branch = v => typeof v === 'string' && BRANCH.test(v) && !v.includes('..') && !v.startsWith('/') && !v.endsWith('/');

function _path(p) {
  const s = typeof p === 'string' ? p.trim() : '';
  if (!s || !path.isAbsolute(s) || s.includes('\0')) throw _fail(400, 'BAD_REPOSITORY', 'path must be an absolute path');
  return path.resolve(s);
}

function _fields(payload, { partial = false } = {}) {
  const out = {};
  if (!partial || payload.path !== undefined) out.path = _path(payload.path);
  if (payload.default_branch !== undefined || !partial) {
    const b = payload.default_branch ?? 'main';
    if (!_branch(b)) throw _fail(400, 'BAD_REPOSITORY', `default_branch "${b}" is not a branch name`);
    out.default_branch = b;
  }
  if (payload.remote !== undefined) {
    if (payload.remote !== null && (typeof payload.remote !== 'string' || !REMOTE.test(payload.remote))) {
      throw _fail(400, 'BAD_REPOSITORY', 'remote must be a git remote (e.g. github.com/owner/repo)');
    }
    out.remote = payload.remote;
  }
  return out;
}

async function _project(ctx, project_id) {
  if (!project_id) throw _fail(400, 'MISSING_PROJECT_ID', 'project_id is required');
  const ark = await Artifact.findById(project_id, ctx);
  if (!ark || ark.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
  return ark;
}

async function _repository(ctx, repository_id) {
  if (!repository_id) throw _fail(400, 'MISSING_REPOSITORY_ID', 'repository_id is required');
  const repo = await Artifact.findById(repository_id, ctx);
  if (!repo || repo.get('artifact_type') !== 'repository') throw _fail(404, 'REPOSITORY_NOT_FOUND', 'Repository not found');
  return repo;
}

// The project's repositories: [{ id, alias, path, default_branch, remote? }]
async function projectRepositories(ctx, project_id) {
  const rels = await ArtifactRelation.findBySource(project_id, 'contains', { select: 'target_artifact_id' });
  const rows = await Artifact.query({ artifact_type: 'repository', ids: rels.map(r => r.target_artifact_id), limit: MAX_REPOS * 2 }, ctx);
  return rows
    .map(r => ({ id: r.id, ...json(r.context) }))
    .map(({ id, alias, path: p, default_branch, remote }) => ({ id, alias, path: p, default_branch, ...(remote ? { remote } : {}) }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

// The projects (Arks) that contain an artifact.
async function containingProjects(ctx, artifact_id) {
  const { data } = await Artifact.db.from('artifact_relations').select('source_artifact_id')
    .eq('target_artifact_id', artifact_id).eq('relation_type', 'contains');
  const ids = [...new Set((data || []).map(r => r.source_artifact_id))];
  return Artifact.query({ artifact_type: 'ark', ids, limit: 10, select: 'id, title' }, ctx);
}

// inputs.project_repositories: 'all' | [alias] | absent. Error message or null.
function inheritError(inputs) {
  const want = inputs?.project_repositories;
  if (want == null || want === 'all') return null;
  if (!Array.isArray(want) || !want.length || want.length > MAX_REPOS || !want.every(a => typeof a === 'string' && ALIAS.test(a))) {
    return 'inputs.project_repositories must be "all" or a list of repository aliases';
  }
  if (new Set(want).size !== want.length) return 'inputs.project_repositories lists an alias twice';
  return null;
}

// A task's context with inherited repositories resolved into
// inputs.repositories (each marked from: 'project'). Unchanged when the task
// doesn't inherit. This — not the stored context — is what approval pins and
// what a run reads.
async function effectiveContext(ctx, task) {
  const tctx = task.get('context') || {};
  const want = tctx.inputs?.project_repositories;
  if (want == null) return tctx;

  const projects = await containingProjects(ctx, task.id);
  if (projects.length !== 1) {
    throw _fail(409, 'PROJECT_AMBIGUOUS', projects.length
      ? `Task inherits project repositories but is in ${projects.length} projects`
      : 'Task inherits project repositories but is not in a project');
  }
  const repos = await projectRepositories(ctx, projects[0].id);
  const picked = want === 'all' ? repos : want.map(alias => {
    const r = repos.find(x => x.alias === alias);
    if (!r) throw _fail(409, 'REPOSITORY_NOT_FOUND', `Project has no repository "${alias}"`);
    return r;
  });
  const own = tctx.inputs.repositories || [];
  const clash = own.filter(o => picked.some(p => p.alias === o.alias)).map(o => o.alias);
  if (clash.length) throw _fail(409, 'DUPLICATE_ALIAS', `Task repositories reuse project aliases: ${clash.join(', ')}`);

  return {
    ...tctx,
    inputs: {
      ...tctx.inputs,
      repositories: [...picked.map(r => ({ alias: r.alias, path: r.path, from: 'project' })), ...own],
    },
  };
}

// payload: { project_id, alias, path, default_branch?, remote? }
async function add(ctx, payload, packet) {
  const project = await _project(ctx, payload.project_id);
  const alias = typeof payload.alias === 'string' ? payload.alias.trim() : '';
  if (!ALIAS.test(alias)) throw _fail(400, 'BAD_REPOSITORY', 'alias: letters, digits, . _ - (max 40), starting with a letter or digit');
  const fields = _fields(payload);
  const existing = await projectRepositories(ctx, project.id);
  if (existing.some(r => r.alias === alias)) throw _fail(409, 'DUPLICATE_ALIAS', `Project already has a repository "${alias}"`);
  if (existing.length >= MAX_REPOS) throw _fail(409, 'TOO_MANY_REPOSITORIES', `A project holds at most ${MAX_REPOS} repositories`);

  const repo = new Artifact({
    artifact_type: 'repository',
    title: alias,
    summary: fields.path,
    status: 'published',
    context: { visibility: 'private', alias, ...fields },
  }, { context: ctx });
  await repo.save();
  const order_index = (await ArtifactRelation.maxOrderIndex(project.id, 'contains')) + 1;
  await new ArtifactRelation({ source_artifact_id: project.id, target_artifact_id: repo.id, relation_type: 'contains', order_index }, { context: ctx }).save();
  await _recordEvent(ctx, { artifact_id: repo.id, event_type: 'repository.added', event_name: 'Repository added', payload: { project_id: project.id, alias, ...fields } });

  packet._objects['repository'] = repo.data;
  packet.log.push(`repository.add → ${alias} (${fields.path}) in ${project.id}`);
  return { data: { repository: repo.data } };
}

// payload: { repository_id, path?, default_branch?, remote? } — alias is fixed.
async function update(ctx, payload, packet) {
  const repo = await _repository(ctx, payload.repository_id);
  if (payload.alias !== undefined && payload.alias !== repo.get('context')?.alias) {
    throw _fail(400, 'BAD_REPOSITORY', 'alias can\'t change — tasks refer to it; remove the repository and add it again');
  }
  const fields = _fields(payload, { partial: true });
  const before = repo.get('context') || {};
  const changed = Object.keys(fields).filter(k => JSON.stringify(fields[k] ?? null) !== JSON.stringify(before[k] ?? null));
  if (!changed.length) throw _fail(400, 'NO_CHANGE', 'nothing to change');
  const next = { ...before, ...fields };
  if (next.remote === null) delete next.remote;
  repo.assign({ context: next, ...(fields.path ? { summary: fields.path } : {}) });
  await repo.save();
  await _recordEvent(ctx, { artifact_id: repo.id, event_type: 'repository.updated', event_name: 'Repository updated',
    payload: { changed, before: Object.fromEntries(changed.map(k => [k, before[k] ?? null])), after: Object.fromEntries(changed.map(k => [k, next[k] ?? null])) } });

  packet._objects['repository'] = repo.data;
  packet.log.push(`repository.update → ${before.alias} (${changed.join(', ')})`);
  return { data: { repository: repo.data, changed } };
}

// payload: { repository_id } — archived and taken out of its projects.
async function remove(ctx, payload, packet) {
  const repo = await _repository(ctx, payload.repository_id);
  repo.assign({ inactive: true });
  await repo.save();
  await ArtifactRelation.deleteWhere({ target_id: repo.id, relation_type: 'contains' });
  await _recordEvent(ctx, { artifact_id: repo.id, event_type: 'repository.removed', event_name: 'Repository removed', payload: { alias: repo.get('context')?.alias } });

  packet.log.push(`repository.remove → ${repo.get('context')?.alias}`);
  return { data: { removed: repo.id } };
}

module.exports = { add, update, remove, projectRepositories, containingProjects, effectiveContext, inheritError };
