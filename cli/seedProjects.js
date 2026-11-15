'use strict';

// Project templates: one mandatory base contract, composed by each domain.
//
//   project-base        kind:'project', shared shell + panels, is_composable
//   project-developer   composes project-base, domain-developer, adds panels
//   project-farm        composes project-base, domain-farm, adds panels
//
// A project instance is an ordinary Ark: `ark.create { title, template_id }`
// with one of these. No new artifact type, no schema change.
//
// Panels are declarative: `source` names a read action + payload; a
// dashboard renders whatever that action returns. Nothing here grants
// authority — capabilities still come from the action and the actor's rank.
//
// seedProjectTemplates() is idempotent (keyed by slug) and writes only
// through dispatch(). For the shared Supabase project the same data needs a
// manual, owner-run SQL migration (store_id NULL), not this function.

const Artifact = require('../domain/Artifact');
const TemplateResolver = require('../core/TemplateResolver');

const DOMAINS = [
  {
    slug: 'domain-developer', title: 'Developer',
    summary: 'Software work: repositories, reviews, agent runs, drift.',
    metadata: { capabilities: ['tasks', 'reviews', 'harness'], allowed_relations: ['contains', 'references'] },
  },
  {
    slug: 'domain-farm', title: 'Farm',
    summary: 'Growing operations: inventory, inspections, recurring care.',
    metadata: { capabilities: ['inventory', 'tasks', 'media'], allowed_relations: ['contains', 'references'] },
  },
];

const BASE = {
  slug: 'project-base', title: 'Project (base)',
  summary: 'Common contract every project composes: shell, defaults, core panels.',
  context: { is_composable: true },
  metadata: {
    kind: 'project',
    ark_type: 'project',
    entry_relation: 'contains',
    defaults: { status: 'draft', context: { visibility: 'private' } },
    dashboard: {
      shell: [
        { id: 'project-switcher', type: 'project_switcher' },
        { id: 'project-header',   type: 'project_header' },
      ],
      panels: [
        { id: 'contents', type: 'artifact_list', title: 'Contents', source: { action: 'ark.get' } },
        { id: 'tasks',    type: 'artifact_list', title: 'Tasks',    source: { action: 'artifact.search', payload: { artifact_type: 'task' } } },
        { id: 'activity', type: 'ledger_feed',   title: 'Activity', source: { action: 'ledger.list', payload: { limit: 20 } } },
      ],
    },
  },
};

const DOMAIN_TEMPLATES = [
  {
    slug: 'project-developer', title: 'Developer project', domain: 'domain-developer',
    summary: 'A software project: tasks, agent reviews, drift watches.',
    metadata: {
      ark_type: 'project',
      dashboard: {
        panels: [
          { id: 'harness', type: 'harness_status', title: 'Agents',  source: { action: 'harness.describe' } },
          { id: 'reviews', type: 'artifact_list',  title: 'Reviews', source: { action: 'artifact.search', payload: { artifact_type: 'review' } } },
        ],
      },
    },
  },
  {
    slug: 'project-farm', title: 'Farm project', domain: 'domain-farm',
    summary: 'A growing operation: inventory, care tasks, field records.',
    metadata: {
      ark_type: 'project',
      dashboard: {
        panels: [
          { id: 'inventory', type: 'artifact_list', title: 'Inventory', source: { action: 'artifact.search', payload: { artifact_type: 'item' } } },
          { id: 'tasks',     type: 'artifact_list', title: 'Care tasks', source: { action: 'artifact.search', payload: { artifact_type: 'task' } } },
        ],
      },
    },
  },
];

async function _existingBySlug(ctx, slugs) {
  let q = Artifact.db.from('artifacts').select('id, slug, artifact_type').in('slug', slugs).eq('inactive', false);
  if (ctx.store_id != null) q = q.eq('store_id', ctx.store_id);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return new Map((data || []).map(r => [r.slug, r.id]));
}

async function _hasRelation(source, target, type) {
  const { data } = await Artifact.db.from('artifact_relations').select('id')
    .eq('source_artifact_id', source).eq('target_artifact_id', target).eq('relation_type', type);
  return !!data?.length;
}

async function seedProjectTemplates(dispatch, ctx) {
  const all = [...DOMAINS.map(d => d.slug), BASE.slug, ...DOMAIN_TEMPLATES.map(t => t.slug)];
  const ids = await _existingBySlug(ctx, all);
  const created = [];

  const create = async (spec, artifact_type, extra = {}) => {
    if (ids.has(spec.slug)) return ids.get(spec.slug);
    const r = await dispatch({ action: 'artifact.create', payload: {
      artifact_type, slug: spec.slug, title: spec.title, summary: spec.summary,
      status: 'published', visibility: 'global', context: spec.context || {},
      metadata: spec.metadata, skip_default_placement: true, ...extra,
    } }, ctx);
    ids.set(spec.slug, r.data.artifact.id);
    created.push(spec.slug);
    return r.data.artifact.id;
  };

  for (const d of DOMAINS) await create(d, 'domain');
  const baseId = await create(BASE, 'template');
  for (const t of DOMAIN_TEMPLATES) {
    const id = await create(t, 'template', { domain_id: ids.get(t.domain) });
    if (!(await _hasRelation(id, baseId, 'composes'))) {
      await dispatch({ action: 'artifact.relate', payload: {
        source_id: id, target_id: baseId, relation_type: 'composes', order_index: 0,
      } }, ctx);
    }
  }

  TemplateResolver.invalidateAll();
  return { created, existing: all.filter(s => !created.includes(s)), ids: Object.fromEntries(ids) };
}

module.exports = { seedProjectTemplates, DOMAINS, BASE, DOMAIN_TEMPLATES };
