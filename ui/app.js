// ARK Mission Control — a thin client over the vessel's governed gateway.
// Every view is a dispatch() call through POST /api/action; nothing here
// reads the database or decides what an actor may see.
//
// Projects are Arks whose pinned template_provenance points at a project
// template. Dashboards are whatever the resolved contract's `dashboard`
// declares — shell entries for chrome, panels for content.

const TOKEN_KEY   = 'ark.mc.token';
const PROJECT_KEY = 'ark.mc.project';

const state = {
  token: null, projects: [], current: null,
  readActions: new Set(),  // exposed actions that change nothing — hidden from Activity
  writes: new Set(),       // exposed actions that change something — drive the controls
  members: [],             // current project's artifacts — candidate evidence
};
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

const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tzShort = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
  .formatToParts(new Date(iso)).find(p => p.type === 'timeZoneName')?.value || tz;
function dayLabel(iso) {
  const d = new Date(iso);
  const key = x => x.toDateString();
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
// Wall-clock 'YYYY-MM-DDTHH:MM' of an instant in a timezone (display/prefill only;
// turning local time back into an instant is the server's job).
function localIn(iso, tz) {
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso))) p[type] = value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// replaceChildren() stringifies null/false into text; this drops them.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));

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
  state.openOnLoad = params.get('artifact');
  if (token) history.replaceState(null, '', location.pathname);
  return store.get(TOKEN_KEY);
}

function renderTokenPrompt(message) {
  $('switcher').hidden = true;
  const input = h('input', { type: 'password', placeholder: 'gateway token', autocomplete: 'off', 'aria-label': 'Gateway token' });
  fill($('main'), h('section', { class: 'state' },
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
  fill($('main'), h('section', { class: 'state' },
    h('h1', { text: 'No projects on this vessel yet' }),
    h('p', { class: 'muted', text: 'A project is an Ark made from a project template. Seed the templates once, then create one:' }),
    h('pre', { text: 'node cli/ark.js seed-projects\nnode cli/ark.js dispatch ark.create \\\n  --payload \'{"title":"My project","template_id":"project-developer"}\'' }),
    h('p', { class: 'faint', text: 'Projects are created from the CLI; Mission Control approves and completes their tasks.' }),
  ));
}

function renderSwitcher() {
  const select = $('project-select');
  fill(select, ...state.projects.map(p =>
    h('option', { value: p.id, text: p.template ? `${p.title} · ${p.template.title}` : p.title })));
  select.value = state.current;
}

// ── project view ─────────────────────────────────────────────────────────────
async function renderProject(id) {
  state.current = id;
  store.set(PROJECT_KEY, id);
  renderSwitcher();
  fill($('main'), h('p', { class: 'muted', text: 'Loading project…' }));

  let d;
  try { d = await call('ark.get', { ark_id: id }); }
  catch (err) { return renderError(err); }
  state.members = d.artifacts || [];

  const dash  = d.contract?.dashboard || { shell: [], panels: [] };
  const shell  = new Set((dash.shell || []).map(s => s.type));
  $('switcher').hidden = !shell.has('project_switcher');

  const view = [];
  if (shell.has('project_header')) view.push(projectHeader(d));
  const grid = h('div', { class: 'grid' });
  for (const panel of dash.panels || []) grid.append(panelShell(panel, d));
  view.push(grid);
  fill($('main'), ...view);
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
  const actionSlot = h('span', { class: 'panel-action' });
  const el = h('section', { class: 'panel', 'data-panel': panel.id || '' },
    h('header', { class: 'panel-head' }, h('h2', { text: panel.title || panel.id || panel.type }), count, scope, actionSlot),
    body);

  const renderer = PANELS[panel.type];
  if (!renderer) {
    fill(body, h('div', { class: 'panel-empty', text: `No renderer for panel type "${panel.type}".` }));
    return el;
  }
  renderer(panel, d)
    .then(({ rows, scope: s, empty, actions = [] }) => {
      scope.textContent = s;
      scope.classList.toggle('pill-accent', s === 'project');
      count.textContent = rows.length ? String(rows.length) : '';
      fill(actionSlot, ...actions.filter(Boolean).map(a => a.el || h('button', { class: 'mini-btn', type: 'button', onclick: a.onclick, text: a.label })));
      fill(body, ...(rows.length ? rows : [h('div', { class: 'panel-empty', text: empty })]));
    })
    .catch(err => fill(body, h('div', { class: 'panel-error', text: `${err.code ? err.code + ': ' : ''}${err.message}` })));
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
      stateLabel ? h('span', { class: `chip neutral state-${stateLabel}`, text: stateLabel }) : null,
      a.summary ? h('span', { text: a.summary.length > 80 ? a.summary.slice(0, 80) + '…' : a.summary }) : null),
  );
}

const LEDGER_DOT = { closed: 'ok', error: 'bad', open: 'warn' };

// Runs system.cycle — the same call the timer makes. Vessel-wide: it fires
// whatever is due across every project, not just this one. Claiming is quick;
// any work it requested keeps running server-side (outcome 'claimed'), so the
// button follows those claims until they settle, then reloads the dashboard.
const CYCLE_POLL_MS = 3000;
const CYCLE_FOLLOW_MS = 20 * 60 * 1000; // a harness run times out at 15 min

function cycleButton() {
  const label = 'Run cycle';
  const btn = h('button', { class: 'mini-btn ghost', type: 'button', text: label, title: 'Fire due event occurrences (vessel-wide)' });
  const show = (text, title = '') => { btn.textContent = text; btn.title = title; };
  const outcomes = rs => Object.entries(rs.reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] || 0) + 1 }), {}))
    .map(([k, n]) => `${n} ${k}`).join(' · ');

  btn.onclick = async () => {
    btn.disabled = true; show('Running…');
    let fired = 0;
    try {
      const { results = [] } = await call('system.cycle', {});
      fired = results.length;
      const pending = results.filter(r => r.outcome === 'claimed');
      const settled = results.filter(r => r.outcome !== 'claimed');
      if (pending.length) {
        const ids = new Set(pending.map(r => r.occurrence_id));
        const until = Date.now() + CYCLE_FOLLOW_MS;
        while (Date.now() < until) {
          show(`${ids.size} running…`, pending.map(r => r.title).join('\n'));
          await new Promise(r => setTimeout(r, CYCLE_POLL_MS));
          const { chains = [] } = await call('chain.list', { status: 'claimed', limit: 100 });
          const still = new Set(chains.map(c => c.id));
          for (const id of [...ids]) if (!still.has(id)) ids.delete(id);
          if (!ids.size) break;
        }
        for (const r of pending) {
          const { chain } = await call('chain.get', { chain_id: r.occurrence_id });
          settled.push({ ...r, outcome: chain.status, error: chain.error ? json(chain.error) : null });
        }
      }
      show(fired ? outcomes(settled) : 'Nothing due',
        settled.map(r => `${r.title} — ${r.outcome}${r.error ? ` (${r.error.code || r.error.message})` : ''}`).join('\n') || 'Nothing came due');
    } catch (err) {
      show(err.code || 'Failed', err.message);
    }
    setTimeout(() => {
      if (fired && state.current) return renderProject(state.current);
      btn.disabled = false; show(label, 'Fire due event occurrences (vessel-wide)');
    }, 2500);
  };
  return btn;
}

// A claim still 'claimed' long after it started: its process most likely
// died mid-run. It is never re-run automatically — surfaced here instead.
// Matches SystemActions.STALE_AFTER_MS.
const STALE_CLAIM_MS = 60 * 60 * 1000;

async function staleClaims(eventIds) {
  if (!eventIds.size) return [];
  const { chains = [] } = await call('chain.list', { status: 'claimed', limit: 100 });
  return chains
    .map(c => ({ ...c, context: json(c.context) }))
    .filter(c => c.action === 'event.occurrence' && eventIds.has(c.context.event_id)
      && Date.now() - Date.parse(c.started_at || c.created_at) > STALE_CLAIM_MS);
}

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

  // Upcoming occurrences, grouped by the viewer's local day. Times are shown
  // in the event's own timezone (that's what "09:00 daily" means), with the
  // zone named when it isn't the viewer's.
  async event_agenda(panel, d) {
    const src  = panel.source || { action: 'event.list' };
    const days = Number(src.payload?.days) || 14;
    const { occurrences = [], events = [], truncated } = await call(src.action, { ...(src.payload || {}), project_id: d.ark.id });
    const rows = [];
    const titles = new Map(events.map(e => [e.id, e.title]));
    const stale = state.readActions.has('chain.list') ? await staleClaims(new Set(titles.keys())).catch(() => []) : [];
    for (const c of stale) {
      rows.push(h('div', { class: 'row stale', tabindex: '0', role: 'button',
        title: `Occurrence ${c.id} was claimed but never settled. It won't re-run on its own.`,
        onclick: () => openArtifact(c.context.event_id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArtifact(c.context.event_id); } } },
        h('span', { class: 'row-title', text: titles.get(c.context.event_id) || 'Event' }),
        h('span', { class: 'row-when', text: rel(c.started_at || c.created_at) }),
        h('span', { class: 'row-sub' },
          h('span', { class: 'dot warn' }),
          h('span', { text: `stale — the ${new Date(c.context.due_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} run never finished` }))));
    }
    let lastDay = null;
    for (const o of occurrences) {
      const day = dayLabel(o.at);
      if (day !== lastDay) { rows.push(h('div', { class: 'day', text: day })); lastDay = day; }
      rows.push(h('div', { class: 'row', tabindex: '0', role: 'button',
        onclick: () => openArtifact(o.event_id),
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArtifact(o.event_id); } } },
        h('span', { class: 'row-title', text: o.title }),
        h('span', { class: 'row-when mono', text: o.local.slice(11) + (o.timezone !== VIEWER_TZ ? ` ${tzShort(o.at, o.timezone)}` : '') }),
        h('span', { class: 'row-sub' },
          h('span', { class: 'chip', text: o.event_type }),
          h('span', { text: o.recurrence }))));
    }
    if (truncated) rows.push(h('div', { class: 'panel-empty', text: 'More occurrences in this window than shown.' }));
    return {
      rows, scope: 'project', empty: `Nothing scheduled in the next ${days} days.`,
      actions: [
        state.writes.has('system.cycle') ? { el: cycleButton() } : null,
        state.writes.has('event.create') ? { label: '+ Event', onclick: () => openEventForm({ project: d.ark }) } : null,
      ],
    };
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
  fill(body, h('p', { class: 'muted', text: 'Loading…' }));
  $('drawer').hidden = false;
  $('drawer-close').focus();

  let d;
  try { d = await call('artifact.get', { artifact_id: id }); }
  catch (err) { return fill(body, h('p', { class: 'panel-error', text: err.message })); }

  const a = d.artifact;
  const c = json(a.context);
  $('drawer-type').textContent = a.artifact_type;
  const kv = [
    ['id', h('span', { class: 'mono', text: a.id })],
    ['status', a.status],
    c.state ? ['state', h('span', { class: `chip neutral state-${c.state}`, text: c.state })] : null,
    c.approved ? ['approved', `${rel(c.approved.at)}${c.approved.by ? ` · ${short(c.approved.by)}` : ''}${c.approved.note ? ` — ${c.approved.note}` : ''}`] : null,
    c.completed ? ['completed', `${rel(c.completed.at)}${c.completed.by ? ` · ${short(c.completed.by)}` : ''}${c.completed.evidence?.note ? ` — ${c.completed.evidence.note}` : ''}`] : null,
    c.completed?.evidence?.artifacts?.length ? ['evidence', `${c.completed.evidence.artifacts.length} artifact${c.completed.evidence.artifacts.length === 1 ? '' : 's'}`] : null,
    ['visibility', c.visibility || '—'],
    ['created', a.created_at ? `${new Date(a.created_at).toLocaleString()} (${rel(a.created_at)})` : '—'],
    ['updated', a.updated_at ? rel(a.updated_at) : '—'],
  ].filter(Boolean);

  fill(body, 
    h('h3', { text: a.title || a.slug || a.id }),
    a.summary ? h('p', { class: 'muted', text: a.summary }) : null,
    a.artifact_type === 'task' ? taskControls(a, c) : null,
    a.artifact_type === 'event' ? eventSection(a, c) : null,
    h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])),
    a.body ? h('div', { class: 'section' }, h('div', { class: 'label', text: 'Body' }), h('div', { class: 'body-text', text: a.body })) : null,
    h('div', { class: 'section' },
      // What already happened to this artifact (artifact_events) — "History",
      // so it never reads as a scheduled event.
      h('div', { class: 'label', text: `History (${(d.events || []).length})` }),
      ...((d.events || []).length
        ? d.events.map(ev => h('div', { class: 'event' },
            h('span', { class: 'chip neutral', text: ev.event_type }),
            h('span', { text: ev.event_name || '' }),
            h('span', { class: 'faint', text: rel(ev.created_at) })))
        : [h('p', { class: 'faint', text: 'Nothing recorded yet.' })])),
  );
}

// ── events ───────────────────────────────────────────────────────────────────
// Schedule, next occurrences and lifecycle controls for a scheduled event.
// A plain (unscheduled) event gets a "Schedule" button instead.
function eventSection(a, c) {
  const can = action => state.writes.has(action);
  const wrap = h('section', { class: 'event-box' });

  if (!c.schedule) {
    fill(wrap,
      h('div', { class: 'label', text: 'Not scheduled' }),
      h('p', { class: 'faint hint', text: 'A plain event. Give it a time to put it on the calendar.' }),
      can('event.update') ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', text: 'Schedule', onclick: () => openEventForm({ event: a }) })) : null);
    return wrap;
  }

  const s = c.schedule;
  const next = h('div', { class: 'next' }, h('p', { class: 'faint', text: 'Loading…' }));
  call('event.list', { event_id: a.id, days: 366, limit: 5 })
    .then(({ occurrences = [] }) => fill(next, ...(occurrences.length
      ? occurrences.map(o => h('div', { class: 'occ' },
          h('span', { text: dayLabel(o.at) }),
          h('span', { class: 'mono', text: `${o.local.slice(11)} ${tzShort(o.at, o.timezone)}` })))
      : [h('p', { class: 'faint', text: c.state === 'active' ? 'No more occurrences.' : `None while ${c.state}.` })])))
    .catch(err => fill(next, h('p', { class: 'panel-error', text: err.message })));

  const error = h('p', { class: 'panel-error', hidden: true });
  const act = async (action, payload = {}) => {
    error.hidden = true;
    try { await call(action, { event_id: a.id, ...payload }); await openArtifact(a.id); if (state.current) renderProject(state.current); }
    catch (err) { error.textContent = `${err.code ? err.code + ': ' : ''}${err.message}`; error.hidden = false; }
  };

  // Cancelling is final: first click arms, second confirms; it disarms itself.
  let armed = null;
  const cancelBtn = h('button', { class: 'btn ghost danger', type: 'button', text: 'Cancel event', onclick: () => {
    if (armed) { clearTimeout(armed); armed = null; return act('event.cancel'); }
    cancelBtn.textContent = 'Confirm — this is final';
    cancelBtn.classList.add('armed');
    armed = setTimeout(() => { armed = null; cancelBtn.textContent = 'Cancel event'; cancelBtn.classList.remove('armed'); }, 4000);
  } });

  const live = c.state !== 'cancelled';
  fill(wrap,
    h('div', { class: 'event-head' },
      h('span', { class: 'chip', text: c.event_type }),
      h('span', { class: `chip neutral state-${c.state}`, text: c.state })),
    h('dl', { class: 'kv' },
      h('dt', { text: 'repeats' }), h('dd', { text: s.kind === 'once' ? 'once' : describeEvery(s.every) }),
      h('dt', { text: s.kind === 'once' ? 'at' : 'from' }), h('dd', { class: 'mono', text: `${localIn(s.start_at, c.timezone).replace('T', ' ')} ${tzShort(s.start_at, c.timezone)}` }),
      s.end_at ? h('dt', { text: 'until' }) : null, s.end_at ? h('dd', { class: 'mono', text: localIn(s.end_at, c.timezone).replace('T', ' ') }) : null,
      h('dt', { text: 'timezone' }), h('dd', { text: c.timezone }),
      h('dt', { text: 'version' }), h('dd', { text: `v${c.schedule_version || 1}` })),
    h('div', { class: 'label', text: 'Next' }),
    next,
    live ? h('div', { class: 'actions' },
      can('event.update') ? h('button', { class: 'btn ghost', type: 'button', text: 'Edit', onclick: () => openEventForm({ event: a }) }) : null,
      c.state === 'active' && can('event.pause')  ? h('button', { class: 'btn ghost', type: 'button', text: 'Pause',  onclick: () => act('event.pause') }) : null,
      c.state === 'paused' && can('event.resume') ? h('button', { class: 'btn', type: 'button', text: 'Resume', onclick: () => act('event.resume') }) : null,
      can('event.cancel') ? cancelBtn : null) : null,
    error);
  return wrap;
}

function describeEvery(every) {
  const m = /^(\d+)([hdw])$/.exec(every || '');
  if (!m) return every;
  const word = { h: 'hour', d: 'day', w: 'week' }[m[2]];
  return m[1] === '1' ? `every ${word}` : `every ${m[1]} ${word}s`;
}

// V8's list omits "UTC", which is also a common VIEWER_TZ.
const TIMEZONES = (() => {
  let zones; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [VIEWER_TZ]; }
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
})();

// Create (with a project) or edit/schedule (with an event) in the drawer.
// Times are entered as wall-clock time in the chosen timezone and sent as
// start_local — the server turns them into instants, DST included.
function openEventForm({ project, event }) {
  const c = event ? json(event.context) : {};
  const s = c.schedule || null;
  const tz0 = c.timezone || VIEWER_TZ;
  const start0 = s ? localIn(s.start_at, tz0) : localIn(new Date(Date.now() + 3600000).toISOString(), tz0).slice(0, 14) + '00';
  const every0 = s?.kind === 'every' ? /^(\d+)([hdw])$/.exec(s.every) : null;

  const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'label', text: label }), input);
  const title = h('input', { type: 'text', required: true, maxlength: '200', value: event?.title || '' });
  const type  = h('input', { type: 'text', required: true, placeholder: 'dev.review', pattern: '[a-z][a-z0-9_]*(\\.[a-z0-9_]+){0,3}', value: c.event_type || '' });
  const date  = h('input', { type: 'date', required: true, value: start0.slice(0, 10) });
  const time  = h('input', { type: 'time', required: true, value: start0.slice(11, 16) });
  // A stored or viewer zone missing from the list would leave nothing selected (tz.value '').
  const zones = TIMEZONES.includes(tz0) ? TIMEZONES : [tz0, ...TIMEZONES];
  const tz    = h('select', {}, ...zones.map(z => h('option', { value: z, text: z })));
  tz.value = tz0;
  const repeat = h('select', {},
    h('option', { value: '', text: 'Does not repeat' }),
    h('option', { value: 'h', text: 'Every … hours' }),
    h('option', { value: 'd', text: 'Every … days' }),
    h('option', { value: 'w', text: 'Every … weeks' }));
  repeat.value = every0 ? every0[2] : '';
  const n = h('input', { type: 'number', min: '1', max: '1000', value: every0 ? every0[1] : '1', 'aria-label': 'Interval' });
  const until = h('input', { type: 'date', value: s?.end_at ? localIn(s.end_at, tz0).slice(0, 10) : '' });
  const repeatRow = h('div', { class: 'inline' }, repeat, n);
  const untilField = field('Until (optional)', until);
  const sync = () => { const on = !!repeat.value; n.hidden = !on; untilField.hidden = !on; };
  repeat.addEventListener('change', sync);
  sync();

  const error = h('p', { class: 'panel-error', hidden: true });
  const submit = h('button', { class: 'btn', type: 'submit', text: event ? (s ? 'Save' : 'Schedule') : 'Create event' });

  const buildSchedule = () => (repeat.value
    ? { kind: 'every', every: `${Math.max(1, Number(n.value) || 1)}${repeat.value}`, start_local: `${date.value}T${time.value}`,
        ...(until.value ? { end_local: `${until.value}T23:59` } : {}) }
    : { kind: 'once', start_local: `${date.value}T${time.value}` });
  // Only a changed schedule is a reschedule (new version, history entry);
  // renaming an event leaves its schedule alone.
  const initial = s ? JSON.stringify([buildSchedule(), tz.value]) : null;

  const form = h('form', { class: 'event-form', onsubmit: async e => {
    e.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    const schedule = buildSchedule();
    const rescheduled = JSON.stringify([schedule, tz.value]) !== initial;
    try {
      let id = event?.id;
      if (event) await call('event.update', { event_id: id, title: title.value, event_type: type.value, ...(rescheduled ? { timezone: tz.value, schedule } : {}) });
      else id = (await call('event.create', { project_id: project.id, title: title.value, event_type: type.value, timezone: tz.value, schedule })).event.id;
      await openArtifact(id);
      if (state.current) renderProject(state.current);
    } catch (err) {
      error.textContent = `${err.code ? err.code + ': ' : ''}${err.message}`;
      error.hidden = false;
      submit.disabled = false;
    }
  } },
    field('Title', title),
    field('Type', type),
    h('div', { class: 'inline' }, field('Date', date), field('Time', time)),
    field('Timezone', tz),
    field('Repeat', repeatRow),
    untilField,
    h('div', { class: 'actions' },
      h('button', { class: 'btn ghost', type: 'button', text: 'Back', onclick: () => (event ? openArtifact(event.id) : closeDrawer()) }),
      submit),
    error);

  $('drawer-type').textContent = event ? (s ? 'Edit event' : 'Schedule event') : 'New event';
  fill($('drawer-body'), h('h3', { text: event ? event.title : `New event in ${project.title}` }), form);
  $('drawer').hidden = false;
  title.focus();
}

// Lifecycle controls: proposed → Approve, ready → Complete. Shown only when
// the gateway exposes the action; the server still decides (rank, state).
function taskControls(a, c) {
  const step = c.state === 'proposed' ? { action: 'task.approve', label: 'Approve', hint: 'Moves the task to ready. Recorded with your identity and the note.' }
             : c.state === 'ready'    ? { action: 'task.complete', label: 'Mark complete', hint: 'Moves the task to resolved, with the note and any evidence as its record.' }
             : null;
  if (!step || !state.writes.has(step.action)) return null;

  const note = h('textarea', { rows: '2', placeholder: step.action === 'task.approve' ? 'Approval note (optional)' : 'What was done (optional)', 'aria-label': 'Note' });
  const evidence = step.action === 'task.complete'
    ? state.members.filter(m => m.id !== a.id && m.artifact_type !== 'task')
    : [];
  const boxes = evidence.map(m => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: m.id }),
    h('span', { class: 'chip', text: m.artifact_type }),
    h('span', { text: m.title || m.slug || m.id })));
  const error  = h('p', { class: 'panel-error', hidden: true });
  const button = h('button', { class: 'btn', type: 'submit', text: step.label });

  const form = h('form', { class: 'task-controls', onsubmit: async e => {
    e.preventDefault();
    button.disabled = true;
    error.hidden = true;
    const payload = { task_id: a.id, note: note.value.trim() || undefined };
    if (step.action === 'task.complete') payload.artifacts = boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value);
    try {
      await call(step.action, payload);
      await openArtifact(a.id);
      if (state.current) renderProject(state.current);
    } catch (err) {
      error.textContent = `${err.code ? err.code + ': ' : ''}${err.message}`;
      error.hidden = false;
      button.disabled = false;
    }
  } },
    h('div', { class: 'label', text: step.label }),
    h('p', { class: 'faint hint', text: step.hint }),
    note,
    boxes.length ? h('details', { class: 'evidence' }, h('summary', { text: `Attach evidence from this project (${boxes.length})` }), ...boxes) : null,
    h('div', { class: 'actions' }, button),
    error);
  return form;
}

function closeDrawer() { $('drawer').hidden = true; }

// ── errors / boot ────────────────────────────────────────────────────────────
function renderError(err) {
  if (err.status === 401) { store.del(TOKEN_KEY); return renderTokenPrompt('That token was not accepted. The gateway issues a new one each time it starts.'); }
  fill($('main'), h('section', { class: 'state' },
    h('h1', { text: 'Something went wrong' }),
    h('p', { class: 'muted', text: `${err.code ? err.code + ': ' : ''}${err.message}` })));
}

async function boot() {
  state.token = readHash();
  if (!state.token) return renderTokenPrompt();
  try {
    const health = await request('/api/health');
    state.writes      = new Set(health.writes || []);
    state.readActions = new Set((health.actions || []).filter(x => !state.writes.has(x)));
    $('mode').hidden  = state.writes.size > 0;
    $('vessel').textContent = `vessel · ${health.vessel}`;
    $('actor').textContent  = health.actor?.display_name ? `${health.actor.display_name} · ${health.actor.role}` : '';
    state.projects = await loadProjects();
  } catch (err) { return renderError(err); }

  if (!state.projects.length) return renderEmpty();
  const saved = store.get(PROJECT_KEY);
  await renderProject(state.projects.some(p => p.id === saved) ? saved : state.projects[0].id);
  if (state.openOnLoad) { openArtifact(state.openOnLoad); state.openOnLoad = null; }
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
