'use strict';

// Project templates end-to-end through dispatch() on a throwaway sqlite
// vessel: base composition, additive dashboard merge, provenance pinning.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const TemplateResolver = require('../core/TemplateResolver');
const { _mergeDashboard } = TemplateResolver._internals;
const { seedProjectTemplates } = require('../cli/seedProjects');

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-projects-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
const run = (action, payload = {}, ctx = ADMIN) => dispatch({ action, payload }, ctx);

let seeded;
before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'projects.sqlite') } });
  seeded = await seedProjectTemplates(dispatch, ADMIN);
});

// A template created through dispatch, optionally composing another.
async function template(slug, metadata, composes) {
  const r = await run('artifact.create', { artifact_type: 'template', slug, title: slug, status: 'published', metadata, skip_default_placement: true });
  if (composes) await run('artifact.relate', { source_id: r.data.artifact.id, target_id: composes, relation_type: 'composes', order_index: 0 });
  TemplateResolver.invalidateAll();
  return r.data.artifact.id;
}

// ── merge rules ──────────────────────────────────────────────────────────────

test('_mergeDashboard: base shell wins, panels override in place, new ids append', () => {
  const m = _mergeDashboard(
    { shell: [{ id: 'hdr', v: 'base' }], panels: [{ id: 'a', v: 1 }, { id: 'b', v: 1 }] },
    { shell: [{ id: 'hdr', v: 'override' }, { id: 'extra' }], panels: [{ id: 'b', v: 2 }, { id: 'c', v: 2 }] },
  );
  assert.deepEqual(m.shell, [{ id: 'hdr', v: 'base' }, { id: 'extra' }]);
  assert.deepEqual(m.panels, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 2 }]);
});

// ── seed ─────────────────────────────────────────────────────────────────────

test('seed: idempotent — a second run creates nothing', async () => {
  assert.deepEqual(seeded.created, ['domain-developer', 'project-base', 'project-developer']);
  const again = await seedProjectTemplates(dispatch, ADMIN);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.updated, [], 'nothing to bring up to date');
  assert.deepEqual(again.ids, seeded.ids);
});

test('seed: an older template is brought up to date (e.g. a vessel seeded before the Upcoming panel)', async () => {
  const { BASE } = require('../cli/seedProjects');
  const older = { ...BASE.metadata.dashboard, panels: BASE.metadata.dashboard.panels.filter(p => p.id !== 'upcoming') };
  await run('artifact.update', { artifact_id: seeded.ids['project-base'], metadata: { dashboard: older } });
  TemplateResolver.invalidateAll();
  assert.ok(!(await TemplateResolver.resolve('project-base')).dashboard.panels.some(p => p.id === 'upcoming'));

  const r = await seedProjectTemplates(dispatch, ADMIN);
  assert.deepEqual(r.updated, ['project-base']);
  assert.ok((await TemplateResolver.resolve('project-developer')).dashboard.panels.some(p => p.id === 'upcoming'));
});

test('seed: domain template inherits kind + base shell/panels and adds its own', async () => {
  const dev = await TemplateResolver.resolve('project-developer');
  assert.equal(dev.kind, 'project');
  assert.equal(dev.domain_id, seeded.ids['domain-developer']);
  assert.deepEqual(dev.dashboard.shell.map(s => s.id), ['project-switcher', 'project-header']);
  assert.deepEqual(dev.dashboard.panels.map(p => p.id), ['contents', 'tasks', 'upcoming', 'activity', 'harness', 'reviews', 'prs']);

  await template('project-ops', { dashboard: { panels: [
    { id: 'tasks', type: 'artifact_list', title: 'Ops tasks', source: { action: 'artifact.search', payload: { artifact_type: 'task' } } },
    { id: 'inventory', type: 'artifact_list', title: 'Inventory' },
  ] } }, seeded.ids['project-base']);
  const ops = await TemplateResolver.resolve('project-ops');
  assert.deepEqual(ops.dashboard.panels.map(p => p.id), ['contents', 'tasks', 'upcoming', 'activity', 'inventory']);
  assert.equal(ops.dashboard.panels.find(p => p.id === 'tasks').title, 'Ops tasks', 'same id → domain version, base position');
});

test('seed: no farm template — only developer projects are seeded', async () => {
  const { DOMAINS, DOMAIN_TEMPLATES } = require('../cli/seedProjects');
  assert.deepEqual(DOMAINS.map(d => d.slug), ['domain-developer']);
  assert.deepEqual(DOMAIN_TEMPLATES.map(t => t.slug), ['project-developer']);
});

test('project: a composing template cannot replace or drop the base shell', async () => {
  await template('project-rogue-shell', { dashboard: { shell: [{ id: 'project-switcher', type: 'nothing' }] } }, seeded.ids['project-base']);
  const c = await TemplateResolver.resolve('project-rogue-shell');
  assert.equal(c.dashboard.shell.find(s => s.id === 'project-switcher').type, 'project_switcher');
});

// ── ark.create / ark.update ──────────────────────────────────────────────────

test('project: create from a domain template records domain + pinned provenance', async () => {
  const r = await run('ark.create', { title: 'ARK itself', template_id: seeded.ids['project-developer'],
    metadata: { template_provenance: { resolved_hash: 'forged' } } });
  const ark = r.data.ark;
  assert.equal(ark.domain_id, seeded.ids['domain-developer']);
  const prov = ark.metadata.template_provenance;
  assert.equal(prov.template_slug, 'project-developer');
  assert.notEqual(prov.resolved_hash, 'forged', 'caller cannot supply provenance');
  assert.equal(prov.resolver_version, TemplateResolver.VERSION);
  assert.ok(prov.composed_from.some(c => c.template_id === seeded.ids['project-base']));

  const listed = await run('ark.list', { domain_id: seeded.ids['domain-developer'] });
  assert.ok(listed.data.arks.some(a => a.id === ark.id));
});

test('project: a kind:"project" template that skips the base is refused', async () => {
  const rogue = await template('project-rogue', { kind: 'project', dashboard: { panels: [{ id: 'x' }] } });
  await assert.rejects(run('ark.create', { title: 'nope', template_id: rogue }),
    err => err.status === 422 && err.code === 'PROJECT_BASE_REQUIRED');

  const ok = await run('ark.create', { title: 'plain', template_id: seeded.ids['project-developer'] });
  await assert.rejects(run('ark.update', { ark_id: ok.data.ark.id, template_id: rogue }),
    err => err.code === 'PROJECT_BASE_REQUIRED');
});

test('project: provenance survives a template edit; changing template re-pins it', async () => {
  const other = await template('project-other', { dashboard: { panels: [{ id: 'notes', type: 'artifact_list', title: 'Notes' }] } }, seeded.ids['project-base']);
  const r = await run('ark.create', { title: 'pinned', template_id: other });
  const before = r.data.ark.metadata.template_provenance;

  await run('artifact.update', { artifact_id: other, metadata: { summary_note: 'edited' } });
  TemplateResolver.invalidateAll();
  const got = await run('ark.get', { ark_id: r.data.ark.id });
  assert.deepEqual(got.data.ark.metadata.template_provenance, before);

  await run('ark.update', { ark_id: r.data.ark.id, metadata: { template_provenance: { resolved_hash: 'forged' } } });
  const still = await run('ark.get', { ark_id: r.data.ark.id });
  assert.deepEqual(still.data.ark.metadata.template_provenance, before, 'metadata update cannot overwrite provenance');

  const moved = await run('ark.update', { ark_id: r.data.ark.id, template_id: seeded.ids['project-developer'] });
  assert.equal(moved.data.ark.domain_id, seeded.ids['domain-developer']);
  const after = await run('ark.get', { ark_id: r.data.ark.id });
  assert.equal(after.data.ark.metadata.template_provenance.template_slug, 'project-developer');
});

// ── guards ───────────────────────────────────────────────────────────────────

test('artifact.create: domain_id only on templates', async () => {
  await assert.rejects(run('artifact.create', { artifact_type: 'note', title: 'n', domain_id: seeded.ids['domain-developer'] }),
    err => err.status === 400);
});

test('harness.run: a task with no state is not runnable', async () => {
  const t = await run('workflow.start', { workflow_key: 'w', tasks: [{ title: 'workflow-shaped', action: 'artifact.list' }] });
  await assert.rejects(run('harness.run', { task_id: t.data.active_task.id }),
    err => err.code === 'TASK_NOT_READY' && /unstated/.test(err.message));
});
