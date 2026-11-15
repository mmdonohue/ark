// ARK Mission Control — a thin client over the vessel's governed gateway.
// Every view is a dispatch() call through POST /api/action; nothing here
// reads the database or decides what an actor may see.
//
// Projects are Arks whose pinned template_provenance points at a project
// template. Dashboards are whatever the resolved contract's `dashboard`
// declares — shell entries for chrome, panels for content.

const TOKEN_KEY   = 'ark.mc.token';
const PROJECT_KEY = 'ark.mc.project';

const state = { token: null, projects: [], current: null, readActions: new Set() };
const $ = id => document.getElementById(id);

// ── storage (session-scoped; never required) ─────────────────────────────────
const store = {
  get(k)    { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k)    { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
};

// ── DOM ──────────────────────────────────────────────────────────────────────
// Data is only ever set as text — never parsed as HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function rel(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const units = [[60, 'm'], [60, 'h'], [24, 'd'], [30, 'mo'], [12, 'y']];
  let v = s / 60, unit = 'm';
  for (let i = 1; i < units.length && v >= units[i][0]; i++) { v /= units[i][0]; unit = units[i][1]; }
  return `${Math.floor(v)}${unit} ago`;
}

const json = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : (v || {}));
const short = s => (s ? String(s).slice(0, 8) : '');

// ── gateway ──────────────────────────────────────────────────────────────────
class GatewayError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${state.token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new GatewayError(body.error?.message || `HTTP ${res.status}`, res.status, body.error?.code);
  }
  return body;
}

const call = async (action, payload = {}) => (await request('/api/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, payload }),
})).data;

// ── token ────────────────────────────────────────────────────────────────────
// #token=…&project=… — token is moved into session storage and stripped
// from the address bar; project is a shareable deep link.
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token && /^[0-9a-f]{16,}$/i.test(token)) store.set(TOKEN_KEY, token);
  if (params.get('project')) store.set(PROJECT_KEY, params.get('project'));
  if (token) history.replaceState(null, '', location.pathname);
  return store.get(TOKEN_KEY);
}

function renderTokenPrompt(message) {
  $('switcher').hidden = true;
  const input = h('input', { type: 'password', placeholder: 'gateway token', autocomplete: 'off', 'aria-label': 'Gateway token' });
  $('main').replaceChildren(h('section', { class: 'state' },
    h('h1', { text: 'Connect to this vessel' }),
    h('p', { class: 'muted', text: message || 'Open the link `ark serve` printed, or paste the token from the gateway.token file next to the vessel database.' }),
    h('form', { onsubmit: e => { e.preventDefault(); if (input.value.trim()) { store.set(TOKEN_KEY, input.value.trim()); boot(); } } },
      input, h('button', { class: 'btn', type: 'submit', text: 'Connect' })),
  ));
}

// ── projects ─────────────────────────────────────────────────────────────────
async function loadProjects() {
  const [{ arks = [] }, { templates = [] }] = await Promise.all([call('ark.list'), call('template.list')]);
  const projectTemplates = new Map();
  for (const t of templates) {
    const m = json(t.metadata);
    if (m.kind === 'project' || m.ark_type === 'project') {
      projectTemplates.set(t.id, t);
      if (t.slug) projectTemplates.set(t.slug, t);
    }
  }
  return arks
    .filter(a => {
      const p = json(a.metadata).template_provenance;
      return p && (projectTemplates.has(p.template_id) || projectTemplates.has(p.template_slug));
    })
    .map(a => { const p = json(a.metadata).template_provenance; return { ...a, template: projectTemplates.get(p.template_slug) || projectTemplates.get(p.template_id) }; })
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

function renderEmpty() {
  $('switcher').hidden = true;
  $('main').replaceChildren(h('section', { class: 'state' },
    h('h1', { text: 'No projects on this vessel yet' }),
    h('p', { class: 'muted', text: 'A project is an Ark made from a project template. Seed the templates once, then create one:' }),
    h('pre', { text: 'node cli/ark.js seed-projects\nnode cli/ark.js dispatch ark.create \\\n  --payload \'{"title":"My project","template_id":"project-developer"}\'' }),
    h('p', { class: 'faint', text: 'This gateway is read-only, so projects are created from the CLI.' }),
  ));
}

function renderSwitcher() {
  const select = $('project-select');
  select.replaceChildren(...state.projects.map(p =>
    h('option', { value: p.id, text: p.template ? `${p.title} · ${p.template.title}` : p.title })));
  select.value = state.current;
}

// ── project view ─────────────────────────────────────────────────────────────
async function renderProject(id) {
  state.current = id;
  store.set(PROJECT_KEY, id);
  renderSwitcher();
  $('main').replaceChildren(h('p', { class: 'muted', text: 'Loading project…' }));

  let d;
  try { d = await call('ark.get', { ark_id: id }); }
  catch (err) { return renderError(err); }

  const dash   = d.contract?.dashboard || { shell: [], panels: [] };
  const shell  = new Set((dash.shell || []).map(s => s.type));
  $('switcher').hidden = !shell.has('project_switcher');

  const view = [];
  if (shell.has('project_header')) view.push(projectHeader(d));
  const grid = h('div', { class: 'grid' });
  for (const panel of dash.panels || []) grid.append(panelShell(panel, d));
  view.push(grid);
  $('main').replaceChildren(...view);
}

function projectHeader({ ark, template, artifacts = [] }) {
  const prov = json(ark.metadata).template_provenance || {};
  return h('section', { class: 'project-head' },
    h('span', { class: 'label', text: template?.title || 'Project' }),
    h('h1', { text: ark.title || ark.slug || ark.id }),
    ark.summary ? h('p', { class: 'summary', text: ark.summary }) : null,
    h('div', { class: 'meta-row' },
      h('span', { class: 'chip', text: prov.template_slug || template?.slug || 'project' }),
      h('span', { class: 'chip neutral', text: `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}` }),
      prov.resolved_hash ? h('span', { class: 'chip neutral', title: `Pinned contract: ${prov.resolved_hash}\nresolver v${prov.resolver_version}`, text: `contract ${short(prov.resolved_hash)}` }) : null,
      h('span', { class: 'faint', text: `created ${rel(ark.created_at)}` }),
    ),
  );
}

// ── panels ───────────────────────────────────────────────────────────────────
function panelShell(panel, d) {
  const count = h('span', { class: 'count' });
  const scope = h('span', { class: 'pill scope' });
  const body  = h('div', { class: 'panel-body' }, h('div', { class: 'panel-empty', text: 'Loading…' }));
  const el = h('section', { class: 'panel', 'data-panel': panel.id || '' },
    h('header', { class: 'panel-head' }, h('h2', { text: panel.title || panel.id || panel.type }), count, scope),
    body);

  const renderer = PANELS[panel.type];
  if (!renderer) {
    body.replaceChildren(h('div', { class: 'panel-empty', text: `No renderer for panel type "${panel.type}".` }));
    return el;
  }
  renderer(panel, d)
    .then(({ rows, scope: s, empty }) => {
      scope.textContent = s;
      scope.classList.toggle('pill-accent', s === 'project');
      count.textContent = rows.length ? String(rows.length) : '';
      body.replaceChildren(...(rows.length ? rows : [h('div', { class: 'panel-empty', text: empty })]));
    })
    .catch(err => body.replaceChildren(h('div', { class: 'panel-error', text: `${err.code ? err.code + ': ' : ''}${err.message}` })));
  return el;
}

function artifactRow(a) {
  const c = json(a.context);
  const stateLabel = c.state || a.status;
  return h('div', { class: 'row', tabindex: '0', role: 'button',
    onclick: () => openArtifact(a.id),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArtifact(a.id); } } },
    h('span', { class: 'row-title', text: a.title || a.slug || a.id }),
    h('span', { class: 'row-when', text: rel(a.updated_at || a.created_at) }),
    h('span', { class: 'row-sub' },
      h('span', { class: 'chip', text: a.artifact_type }),
      stateLabel ? h('span', { class: 'chip neutral', text: stateLabel }) : null,
      a.summary ? h('span', { text: a.summary.length > 80 ? a.summary.slice(0, 80) + '…' : a.summary }) : null),
  );
}

const LEDGER_DOT = { closed: 'ok', error: 'bad', open: 'warn' };

const PANELS = {
  // source ark.get → the project's own members (already loaded).
  // source artifact.search → scoped to this project via ark_id.
  // Anything else runs as declared and is labelled vessel-wide.
  async artifact_list(panel, d) {
    const src = panel.source || {};
    if (!src.action || src.action === 'ark.get') {
      return { rows: (d.artifacts || []).map(artifactRow), scope: 'project', empty: 'Nothing in this project yet.' };
    }
    const projectScoped = src.action === 'artifact.search';
    const payload = { ...(src.payload || {}), ...(projectScoped ? { ark_id: d.ark.id } : {}) };
    const data = await call(src.action, payload);
    const items = data.artifacts || data.arks || [];
    return { rows: items.map(artifactRow), scope: projectScoped ? 'project' : 'vessel', empty: 'None yet.' };
  },

  // Activity = what changed. Reads (including this dashboard's own) are in
  // the ledger too but would drown everything else, so the feed fetches
  // deeper and drops the gateway's read actions, then shows the declared
  // number of entries.
  async ledger_feed(panel) {
    const src  = panel.source || { action: 'ledger.list' };
    const want = Number(src.payload?.limit) || 20;
    const { ledger = [] } = await call(src.action, { ...(src.payload || {}), limit: Math.min(want * 5, 200) });
    const changes = ledger.filter(e => !state.readActions.has(e.action)).slice(0, want);
    const rows = changes.map(e => h('div', { class: 'row static' },
      h('span', { class: 'row-title mono', text: e.action }),
      h('span', { class: 'row-when', text: rel(e.opened_at) }),
      h('span', { class: 'row-sub' },
        h('span', { class: `dot ${LEDGER_DOT[e.status] || ''}`, title: e.status }),
        h('span', { text: e.status }),
        e.resolution ? h('span', { class: 'chip neutral', text: e.resolution }) : null,
        e.duration_ms != null ? h('span', { text: `${e.duration_ms} ms` }) : null,
        e.error ? h('span', { class: 'faint', text: e.error }) : null),
    ));
    return { rows, scope: 'vessel', empty: 'No changes recorded yet.' };
  },

  async harness_status(panel) {
    const src = panel.source || { action: 'harness.describe' };
    const { drivers = [] } = await call(src.action, src.payload || {});
    const rows = drivers.map(dr => h('div', { class: 'row static' },
      h('span', { class: 'row-title', text: dr.name }),
      h('span', { class: 'row-when', text: dr.version || '' }),
      h('span', { class: 'row-sub' },
        h('span', { class: `dot ${dr.available ? 'ok' : 'bad'}` }),
        h('span', { class: 'chip', text: dr.kind }),
        h('span', { text: dr.available ? 'available' : (dr.reason || 'unavailable') }),
        dr.cooldown_until ? h('span', { class: 'faint', text: `cooling down until ${new Date(dr.cooldown_until).toLocaleTimeString()}` }) : null),
    ));
    return { rows, scope: 'vessel', empty: 'No agent drivers configured on this vessel.' };
  },
};

// ── artifact drawer ──────────────────────────────────────────────────────────
async function openArtifact(id) {
  const body = $('drawer-body');
  $('drawer-type').textContent = 'Artifact';
  body.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  $('drawer').hidden = false;
  $('drawer-close').focus();

  let d;
  try { d = await call('artifact.get', { artifact_id: id }); }
  catch (err) { return body.replaceChildren(h('p', { class: 'panel-error', text: err.message })); }

  const a = d.artifact;
  const c = json(a.context);
  $('drawer-type').textContent = a.artifact_type;
  const kv = [
    ['id', h('span', { class: 'mono', text: a.id })],
    ['status', a.status],
    c.state ? ['state', c.state] : null,
    ['visibility', c.visibility || '—'],
    ['created', a.created_at ? `${new Date(a.created_at).toLocaleString()} (${rel(a.created_at)})` : '—'],
    ['updated', a.updated_at ? rel(a.updated_at) : '—'],
  ].filter(Boolean);

  body.replaceChildren(
    h('h3', { text: a.title || a.slug || a.id }),
    a.summary ? h('p', { class: 'muted', text: a.summary }) : null,
    h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])),
    a.body ? h('div', { class: 'section' }, h('div', { class: 'label', text: 'Body' }), h('div', { class: 'body-text', text: a.body })) : null,
    h('div', { class: 'section' },
      h('div', { class: 'label', text: `Events (${(d.events || []).length})` }),
      ...((d.events || []).length
        ? d.events.map(ev => h('div', { class: 'event' },
            h('span', { class: 'chip neutral', text: ev.event_type }),
            h('span', { text: ev.event_name || '' }),
            h('span', { class: 'faint', text: rel(ev.created_at) })))
        : [h('p', { class: 'faint', text: 'No events recorded.' })])),
  );
}

function closeDrawer() { $('drawer').hidden = true; }

// ── errors / boot ────────────────────────────────────────────────────────────
function renderError(err) {
  if (err.status === 401) { store.del(TOKEN_KEY); return renderTokenPrompt('That token was not accepted. The gateway issues a new one each time it starts.'); }
  $('main').replaceChildren(h('section', { class: 'state' },
    h('h1', { text: 'Something went wrong' }),
    h('p', { class: 'muted', text: `${err.code ? err.code + ': ' : ''}${err.message}` })));
}

async function boot() {
  state.token = readHash();
  if (!state.token) return renderTokenPrompt();
  try {
    const health = await request('/api/health');
    state.readActions = new Set(health.actions || []);
    $('vessel').textContent = `vessel · ${health.vessel}`;
    $('actor').textContent  = health.actor?.display_name ? `${health.actor.display_name} · ${health.actor.role}` : '';
    state.projects = await loadProjects();
  } catch (err) { return renderError(err); }

  if (!state.projects.length) return renderEmpty();
  const saved = store.get(PROJECT_KEY);
  await renderProject(state.projects.some(p => p.id === saved) ? saved : state.projects[0].id);
}

$('project-select').addEventListener('change', e => renderProject(e.target.value));
$('refresh').addEventListener('click', async () => {
  try { state.projects = await loadProjects(); } catch (err) { return renderError(err); }
  if (state.current && state.projects.some(p => p.id === state.current)) renderProject(state.current);
  else boot();
});
$('drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

boot();
