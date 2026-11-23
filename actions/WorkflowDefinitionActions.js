'use strict';

// WorkflowDefinitionActions — a project's reusable workflows.
//
//   artifact_type: 'workflow'
//   context: { alias, revision, title, description?, inputs, steps }  (utils/workflowDef.js)
//   project —[contains]→ workflow
//
// A project's template offers default definitions (contract.workflows). A
// project uses them as they are, or defines its own under the same alias,
// which replaces the default for that project — the way repositories are
// inherited. workflow.definitions returns the effective list.
//
// Every change bumps the revision; the event keeps the previous definition,
// so a run can always show exactly what it was launched from. The alias is
// the identity (runs and events name it): it can't be renamed. Defining,
// redefining and retiring are an admin's acts (workflow.write, rank 100).

const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const TemplateResolver = require('../core/TemplateResolver');
const { _recordEvent } = require('./ArtifactActions');
const { definitionError, normalize } = require('../utils/workflowDef');
const { withLock } = require('../utils/keyedLock');

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const json = v => (typeof v === 'string' ? JSON.parse(v || '{}') : (v || {}));
const MAX_WORKFLOWS = 50;
const EDITABLE = ['title', 'description', 'inputs', 'steps'];

// Actions an automated step may name: everything dispatch() can route.
function _registered() {
  const { ACTION_REGISTRY } = require('../core/dispatch');
  const HostActions = require('../core/HostActions');
  return new Set(Object.keys(HostActions.merged(ACTION_REGISTRY)));
}

function _validated(def) {
  const bad = definitionError(def, { registered: _registered() });
  if (bad) throw _fail(400, 'BAD_WORKFLOW', bad);
  return normalize(def);
}

async function _project(ctx, project_id) {
  if (!project_id) throw _fail(400, 'MISSING_PROJECT_ID', 'project_id is required');
  const ark = await Artifact.findById(project_id, ctx);
  if (!ark || ark.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
  return ark;
}

async function _workflow(ctx, workflow_id) {
  if (!workflow_id) throw _fail(400, 'MISSING_WORKFLOW_ID', 'workflow_id is required');
  const wf = await Artifact.findById(workflow_id, ctx);
  if (!wf || wf.get('artifact_type') !== 'workflow') throw _fail(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
  if (wf.get('inactive')) throw _fail(409, 'WORKFLOW_RETIRED', 'This workflow was retired — define a new one');
  return wf;
}

const _stored = wf => ({ id: wf.id, ...json(wf.get ? wf.get('context') : wf.context) });
const _public = ({ visibility, ...def }) => def;

// The project's own definitions.
async function projectWorkflows(ctx, project_id) {
  const rels = await ArtifactRelation.findBySource(project_id, 'contains', { select: 'target_artifact_id' });
  const rows = await Artifact.query({ artifact_type: 'workflow', ids: rels.map(r => r.target_artifact_id), limit: MAX_WORKFLOWS * 2 }, ctx);
  return rows.map(r => _public(_stored(r))).sort((a, b) => a.alias.localeCompare(b.alias));
}

// The template's defaults for this project.
async function templateWorkflows(project) {
  const m = json(project.get('metadata'));
  const templateId = project.get('template_id') || project.get('context')?.template_id || m.template_provenance?.template_id;
  if (!templateId) return { template: null, workflows: [] };
  const contract = await TemplateResolver.resolve(templateId);
  return { template: contract?.slug || null, workflows: contract?.workflows || [] };
}

// Effective definitions: template defaults, replaced alias-for-alias by the
// project's own. A default that doesn't validate is listed with its error
// rather than silently dropped.
async function effectiveWorkflows(ctx, project) {
  const [{ template, workflows: defaults }, own] = await Promise.all([templateWorkflows(project), projectWorkflows(ctx, project.id)]);
  const out = new Map();
  for (const d of defaults) {
    const bad = definitionError(d);
    out.set(d?.alias, bad
      ? { alias: d?.alias ?? null, title: d?.title ?? null, from: 'template', template, error: bad }
      : { ...normalize(d), revision: d.revision || 1, from: 'template', template });
  }
  for (const w of own) out.set(w.alias, { ...w, from: 'project', ...(out.has(w.alias) ? { overrides: template } : {}) });
  return [...out.values()].sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
}

// payload: { project_id, alias, title, description?, inputs?, steps }
async function define(ctx, payload, packet) {
  const project = await _project(ctx, payload.project_id);
  const def = _validated({ alias: payload.alias, title: payload.title, description: payload.description, inputs: payload.inputs, steps: payload.steps });
  // The alias check and the insert happen as one step per project.
  return withLock(`workflow.define:${project.id}`, () => _define(ctx, project, def, packet));
}

async function _define(ctx, project, def, packet) {
  const own = await projectWorkflows(ctx, project.id);
  if (own.some(w => w.alias === def.alias)) throw _fail(409, 'DUPLICATE_ALIAS', `Project already defines "${def.alias}" — redefine it instead`);
  if (own.length >= MAX_WORKFLOWS) throw _fail(409, 'TOO_MANY_WORKFLOWS', `A project holds at most ${MAX_WORKFLOWS} workflows`);
  const { workflows: defaults } = await templateWorkflows(project);
  const overrides = defaults.some(d => d?.alias === def.alias);

  const wf = new Artifact({
    artifact_type: 'workflow',
    title: def.title,
    summary: def.description || `${def.steps.length} steps`,
    status: 'published',
    context: { visibility: 'private', ...def, revision: 1 },
  }, { context: ctx });
  await wf.save();
  const order_index = (await ArtifactRelation.maxOrderIndex(project.id, 'contains')) + 1;
  await new ArtifactRelation({ source_artifact_id: project.id, target_artifact_id: wf.id, relation_type: 'contains', order_index }, { context: ctx }).save();
  await _recordEvent(ctx, { artifact_id: wf.id, event_type: 'workflow.defined', event_name: 'Workflow defined',
    payload: { project_id: project.id, alias: def.alias, revision: 1, steps: def.steps.length, overrides_template: overrides } });

  packet._objects['workflow'] = wf.data;
  packet.log.push(`workflow.define → ${def.alias} r1 (${def.steps.length} steps) in ${project.id}${overrides ? ' — overrides the template default' : ''}`);
  return { data: { workflow: wf.data } };
}

// payload: { workflow_id, changes: { title?, description?, inputs?, steps? }, note? }
async function redefine(ctx, payload, packet) {
  const wf = await _workflow(ctx, payload.workflow_id);
  const changes = payload.changes;
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw _fail(400, 'BAD_CHANGES', 'changes must be an object');
  const extra = Object.keys(changes).filter(k => !EDITABLE.includes(k));
  if (extra.length) {
    throw _fail(400, 'BAD_CHANGES', extra.includes('alias')
      ? 'alias can\'t change — runs and events refer to it; retire this workflow and define a new one'
      : `can't change ${extra.join(', ')} — editable: ${EDITABLE.join(', ')}`);
  }
  const { visibility, revision, ...before } = json(wf.get('context'));
  const def = _validated({ ...before, ...changes });
  const changed = EDITABLE.filter(k => JSON.stringify(def[k] ?? null) !== JSON.stringify(before[k] ?? null));
  if (!changed.length) throw _fail(400, 'NO_CHANGE', 'nothing to change');

  const next = { visibility, ...def, revision: revision + 1 };
  wf.assign({ title: def.title, summary: def.description || `${def.steps.length} steps`, context: next });
  await wf.save();
  const note = payload.note == null ? null : String(payload.note).trim().slice(0, 2000) || null;
  await _recordEvent(ctx, { artifact_id: wf.id, event_type: 'workflow.redefined', event_name: `Workflow revised to r${next.revision}`,
    payload: { changed, from_revision: revision, to_revision: next.revision, previous: { ...before, revision }, ...(note ? { note } : {}) } });

  packet._objects['workflow'] = wf.data;
  packet.log.push(`workflow.redefine → ${def.alias} r${revision} → r${next.revision} (${changed.join(', ')})`);
  return { data: { workflow: wf.data, changed } };
}

// payload: { workflow_id } — archived and taken out of its project; the
// template default (if any) applies again.
async function retire(ctx, payload, packet) {
  const wf = await _workflow(ctx, payload.workflow_id);
  const { alias, revision } = json(wf.get('context'));
  wf.assign({ inactive: true });
  await wf.save();
  await ArtifactRelation.deleteWhere({ target_id: wf.id, relation_type: 'contains' });
  await _recordEvent(ctx, { artifact_id: wf.id, event_type: 'workflow.retired', event_name: 'Workflow retired', payload: { alias, revision } });
  packet.log.push(`workflow.retire → ${alias} r${revision}`);
  return { data: { retired: wf.id } };
}

// payload: { project_id }
async function definitions(ctx, payload, packet) {
  const project = await _project(ctx, payload.project_id);
  const workflows = await effectiveWorkflows(ctx, project);
  packet.log.push(`workflow.definitions → ${project.id} (${workflows.length})`);
  return { data: { workflows } };
}

module.exports = { define, redefine, retire, definitions, effectiveWorkflows, projectWorkflows };
