// TemplateResolver — resolves template artifacts into merged contracts.
// Composes contracts from related templates (via 'composes' relations) before merging.
// Caches resolved contracts with a 5-minute TTL.
// Requires migration 022 (domain_id + template_id columns on artifacts).

// Reads through the active db adapter (sqlite or postgres), never a fixed
// cloud client — templates live in whichever vessel booted. Lazy require:
// bootstrap.js requires this module.
function _db() {
  return require('./bootstrap').getManifest().get('db').raw;
}

const crypto = require('crypto');

const TTL       = 5 * 60 * 1000;
const MAX_DEPTH = 5;
// Bump whenever the resolved contract's shape changes — resolved_hash
// values from different versions are not comparable.
//   1: original shape
//   2: + kind, + dashboard
//   3: + workflows
const VERSION   = '3';

class TemplateResolver {
  static _cache = new Map(); // id or slug → { contract, loadedAt }

  // Returns a fully merged contract or null if the template can't be found.
  static async resolve(idOrSlug) {
    if (!idOrSlug) return null;

    const cached = this._cache.get(idOrSlug);
    if (cached && (Date.now() - cached.loadedAt) < TTL) return cached.contract;

    try {
      const contract = await this._load(idOrSlug, 0, new Set());
      if (contract) {
        this._cache.set(idOrSlug, { contract, loadedAt: Date.now() });
        // Also index by the other key so both id and slug hit the same cache entry
        if (contract.id && contract.id !== idOrSlug)     this._cache.set(contract.id,   { contract, loadedAt: Date.now() });
        if (contract.slug && contract.slug !== idOrSlug) this._cache.set(contract.slug, { contract, loadedAt: Date.now() });
      }
      return contract;
    } catch (err) {
      console.warn(`[TemplateResolver] ${idOrSlug}: ${err.message}`);
      return null;
    }
  }

  static async _load(idOrSlug, depth, visited) {
    if (depth >= MAX_DEPTH) {
      console.warn(`[TemplateResolver] max composition depth reached at "${idOrSlug}"`);
      return null;
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

    const db = _db();
    let q = db
      .from('artifacts')
      .select('id, slug, title, domain_id, metadata, artifact_type, content_hash')
      .eq('artifact_type', 'template')
      .eq('inactive', false);

    q = isUuid ? q.eq('id', idOrSlug) : q.eq('slug', idOrSlug);

    const { data: tmpl, error } = await q.single();
    if (error || !tmpl) return null;
    if (visited.has(tmpl.id)) return null; // cycle guard
    visited.add(tmpl.id);

    // Load 'composes' relations ordered by index (lowest = applied first = base)
    const { data: composes } = await db
      .from('artifact_relations')
      .select('target_artifact_id, order_index')
      .eq('source_artifact_id', tmpl.id)
      .eq('relation_type', 'composes')
      .order('order_index', { ascending: true });

    // Resolve composed contracts, merge in order (each layer overrides the previous).
    // Track every composed template so provenance can answer: composed from what?
    let base        = _emptyContract();
    const composed_from = [];
    for (const comp of (composes || [])) {
      const child = await this._load(comp.target_artifact_id, depth + 1, visited);
      if (child) {
        base = _merge(base, child);
        composed_from.push({ template_id: child.id, content_hash: child.template_content_hash });
        // Flatten grandchild composition chain into the list
        if (child.composed_from?.length) composed_from.push(...child.composed_from);
      }
    }

    // Primary template is the final override
    const merged = _merge(base, _extractContract(tmpl));
    merged.composed_from = composed_from;
    return merged;
  }

  // Pre-warm cache at bootstrap
  static async prime(idsOrSlugs = []) {
    const results = await Promise.allSettled(idsOrSlugs.map(s => this.resolve(s)));
    const loaded  = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    console.log(`  ✓ Templates primed (${loaded}/${idsOrSlugs.length})`);
    return loaded;
  }

  static hash(contract) {
    if (!contract) return null;
    try {
      return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
    } catch {
      return null;
    }
  }

  // What an instance records about the contract it was created under — the
  // same identity fields PCER puts on every ExecutionPacket, pinned onto the
  // artifact so it stays answerable after the template is edited.
  static provenance(contract) {
    if (!contract) return null;
    return {
      template_id:           contract.id || null,
      template_slug:         contract.slug || null,
      template_content_hash: contract.template_content_hash || null,
      resolved_hash:         this.hash(contract),
      composed_from:         contract.composed_from || [],
      resolver_version:      VERSION,
    };
  }

  static invalidate(idOrSlug)  { this._cache.delete(idOrSlug); }
  static invalidateAll()       { this._cache.clear(); }

  static snapshot() {
    const out = {};
    for (const [key, entry] of this._cache.entries()) {
      out[key] = {
        slug:      entry.contract.slug,
        title:     entry.contract.title,
        loadedAt:  new Date(entry.loadedAt).toISOString(),
        expiresAt: new Date(entry.loadedAt + TTL).toISOString(),
      };
    }
    return out;
  }
}

// ── Contract helpers ────────────────────────────────────────────────────────────

function _emptyContract() {
  return {
    id:                   null,
    slug:                 null,
    title:                null,
    domain_id:            null,
    // What kind of thing an instance of this template is — e.g. 'project'.
    // Scalar, override wins, so a domain template inherits it from its base.
    kind:                 null,
    entry_relation:       null,
    entry_artifact_type:  null,
    fields:               [],
    defaults:             {},
    validators:           [],
    workflow_hooks:       [],
    ai_hints:             {},
    ui:                   {},
    // Composable dashboard description, merged additively (see
    // _mergeDashboard) — unlike `ui`, which an override replaces wholesale.
    //   shell:  [{ id, ... }]  base-owned chrome; a composing template can add
    //                          entries but never replace or drop a base one
    //   panels: [{ id, ... }]  base first; same id → override's version in
    //                          the base's position; new ids appended
    dashboard:            { shell: [], panels: [] },
    // Default workflow definitions (utils/workflowDef.js) a project offers
    // until it defines its own under the same alias. Keyed by alias; a
    // composing template's definition replaces the base's.
    workflows:            [],
    // Declares what this contract returns and how it resolves.
    //
    // Outer contract types (what the workflow returns to the caller):
    //   'artifact' | 'packet' | 'status' | 'composite'
    //
    // Execution trace types (how PCER handles a trace contract's result):
    //   'merge'  — result keys folded into the growing ExecutionPacket
    //   'void'   — executes, contributes nothing to the packet (side effect only)
    //   'gate'   — executes, no output, aborts pipeline on failure
    //
    // payload: keys from the result to include (for 'merge') or pass through (for outer)
    // merge_strategy: how merge results are applied ('assign' | 'deep')
    // resolution: maps execution outcome → resolution label
    response: {
      type:           null,
      payload:        [],
      merge_strategy: 'assign',   // 'assign' = Object.assign; 'deep' = recursive merge
      resolution: {
        success: 'all_steps_completed',
        partial: 'some_steps_skipped',
        failure: 'any_required_step_failed',
      },
    },

    // Contract-level scope declaration — read by service.bind and scope.resolve.
    // Declares what the runtime must prepare for this contract:
    //   artifacts: 'current' | 'user_graph' | false
    //   services:  ['storage', 'llm', 'search']
    //   history:   true | false
    //   observers: true | false
    //   memory:    true | false
    scope: {},

    // Ordered list of trace contracts that PCER runs before the main handler.
    // Defaults (trace.open, auth.verify, scope.resolve, payload.project, service.bind)
    // are always prepended. Contracts append custom stages via this array.
    // Each entry: { action, response: { type, payload? }, scope?, required? }
    execution_trace: [],

    // Provenance fields — carried through to the ExecutionPacket
    template_content_hash: null,  // SHA-256 of the source template artifact as stored
    composed_from:         [],    // [{ template_id, content_hash }] — composition chain
  };
}

function _extractContract(tmpl) {
  const m = tmpl.metadata || {};
  return {
    id:                   tmpl.id,
    slug:                 tmpl.slug    || null,
    title:                tmpl.title   || null,
    domain_id:            tmpl.domain_id || null,
    kind:                 m.kind                 || null,
    entry_relation:       m.entry_relation       || null,
    entry_artifact_type:  m.entry_artifact_type  || null,
    fields:               Array.isArray(m.fields)         ? m.fields         : [],
    defaults:             m.defaults        && typeof m.defaults === 'object'        ? m.defaults        : {},
    validators:           Array.isArray(m.validators)     ? m.validators     : [],
    workflow_hooks:       Array.isArray(m.workflow_hooks) ? m.workflow_hooks : [],
    ai_hints:             m.ai_hints  && typeof m.ai_hints === 'object'  ? m.ai_hints  : {},
    ui:                   m.ui        && typeof m.ui === 'object'        ? m.ui        : {},
    dashboard: {
      shell:  Array.isArray(m.dashboard?.shell)  ? m.dashboard.shell  : [],
      panels: Array.isArray(m.dashboard?.panels) ? m.dashboard.panels : [],
    },
    workflows:            Array.isArray(m.workflows) ? m.workflows : [],
    response:             m.response        && typeof m.response === 'object'  ? m.response        : {},
    scope:                 m.scope           && typeof m.scope    === 'object'  ? m.scope           : {},
    execution_trace:       Array.isArray(m.execution_trace) ? m.execution_trace : [],
    template_content_hash: tmpl.content_hash || null,
    composed_from:         [],
  };
}

// Merge: base is applied first, override wins on conflicts.
// fields: keyed by 'key' — override replaces matching base fields
// defaults: deep merge, override wins
// validators + workflow_hooks: concat (base first)
// ai_hints: deep merge, override wins
// ui: override replaces entirely if non-empty
// kind: scalar, override wins
// dashboard: additive — see _mergeDashboard
// workflows: keyed by alias, override wins
function _merge(base, override) {
  const fieldMap = {};
  for (const f of base.fields)     fieldMap[f.key] = f;
  for (const f of override.fields) fieldMap[f.key] = f;

  return {
    id:                   override.id                  || base.id,
    slug:                 override.slug                || base.slug,
    title:                override.title               || base.title,
    domain_id:            override.domain_id           || base.domain_id,
    kind:                 override.kind                || base.kind,
    entry_relation:       override.entry_relation      || base.entry_relation,
    entry_artifact_type:  override.entry_artifact_type || base.entry_artifact_type,
    fields:               Object.values(fieldMap),
    defaults:             _deepMerge(base.defaults,      override.defaults),
    validators:           [...base.validators,            ...override.validators],
    workflow_hooks:       [...base.workflow_hooks,        ...override.workflow_hooks],
    ai_hints:             _deepMerge(base.ai_hints,       override.ai_hints),
    ui:                   Object.keys(override.ui || {}).length ? override.ui : base.ui,
    dashboard:            _mergeDashboard(base.dashboard, override.dashboard),
    workflows:            _mergeByAlias(base.workflows || [], override.workflows || []),
    response:             _deepMerge(base.response,  override.response),
    scope:                 _deepMerge(base.scope,     override.scope),
    execution_trace:       [...base.execution_trace,  ...override.execution_trace],
    // override (primary template) wins for source hash; composed_from set by _load
    template_content_hash: override.template_content_hash || base.template_content_hash,
    composed_from:         [],
  };
}

// Entries are keyed by `id`; entries without one can't be matched, so they
// are always appended.
function _mergeById(base = [], override = [], { baseWins }) {
  const out = [...base];
  const at  = new Map(out.map((e, i) => [e?.id, i]).filter(([id]) => id != null));
  for (const e of override) {
    const i = e?.id != null ? at.get(e.id) : undefined;
    if (i === undefined) { if (e?.id != null) at.set(e.id, out.length); out.push(e); }
    else if (!baseWins) out[i] = e;
  }
  return out;
}

function _mergeByAlias(base, override) {
  const out = new Map(base.map(w => [w?.alias, w]));
  for (const w of override) out.set(w?.alias, w);
  return [...out.values()];
}

function _mergeDashboard(base = {}, override = {}) {
  return {
    shell:  _mergeById(base.shell,  override.shell,  { baseWins: true }),
    panels: _mergeById(base.panels, override.panels, { baseWins: false }),
  };
}

function _deepMerge(base, override) {
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)
        && result[k] !== null && typeof result[k] === 'object' && !Array.isArray(result[k])) {
      result[k] = _deepMerge(result[k], v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

module.exports = TemplateResolver;
module.exports.VERSION = VERSION;
module.exports._internals = { _emptyContract, _extractContract, _merge, _deepMerge, _mergeDashboard };
