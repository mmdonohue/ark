'use strict';

const { scopeHash } = require('./taskScope');
const { effectiveContext, containingProjects, projectRepositories } = require('../actions/RepositoryActions');

const fail = (code, message) => Object.assign(new Error(message), { status: 422, code });

function intentHash(task) {
  const c = task.get('context') || {};
  return scopeHash({ inputs: { title: task.get('title'), body: task.get('body'), acceptance_criteria: c.acceptance_criteria || [] } });
}

async function resolve(ctx, task) {
  const effective = await effectiveContext(ctx, task);
  if (effective.kind === 'pr') throw fail('BAD_WORKSPACE_SCOPE', 'A PR intent cannot provision an implementation workspace');
  const w = effective.inputs?.workspace;
  if (!w || typeof w !== 'object' || Array.isArray(w)
      || Object.keys(w).some(k => !['mode', 'repository_id', 'alias', 'path', 'base_sha'].includes(k))
      || w.mode !== 'implementation_worktree'
      || typeof w.repository_id !== 'string' || typeof w.alias !== 'string'
      || typeof w.path !== 'string' || !/^[0-9a-f]{40,64}$/.test(w.base_sha || '')) {
    throw fail('BAD_WORKSPACE_SCOPE', 'inputs.workspace must name the implementation mode, repository id, alias, path and full base commit SHA');
  }
  if (!effective.required_capabilities?.includes('workspace.provision')) {
    throw fail('BAD_WORKSPACE_SCOPE', 'The task must explicitly request workspace.provision');
  }
  const projects = await containingProjects(ctx, task.id);
  if (projects.length !== 1) throw fail('BAD_WORKSPACE_SCOPE', 'The task must belong to exactly one project');
  const repos = await projectRepositories(ctx, projects[0].id);
  const repo = repos.find(r => r.id === w.repository_id);
  if (!repo || repo.alias !== w.alias || repo.path !== w.path
      || !effective.inputs?.repositories?.some(r => r.from === 'project' && r.alias === w.alias && r.path === w.path)) {
    throw fail('BAD_WORKSPACE_SCOPE', 'The workspace repository must be the selected, inherited project repository');
  }
  return { effective, workspace: w, project_id: projects[0].id };
}

module.exports = { intentHash, resolve };
