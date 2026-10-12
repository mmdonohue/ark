const crypto           = require('crypto');
const Packet           = require('../core/Packet');
const TemplateResolver = require('../core/TemplateResolver');

class Artifact extends Packet {
  static table       = 'artifacts';
  static storeScoped = true; // UPDATE/DELETE always scoped to store_id

  async prepare() {
    if (!this.data.store_id && this.context.store_id) this.set('store_id', this.context.store_id);
    if (!this.data.site_id  && this.context.site_id)  this.set('site_id', this.context.site_id);

    // Recompute content hash whenever semantic fields are present
    if (this.data.artifact_type || this.data.title || this.data.body) {
      this.set('content_hash', _packetFingerprint(this.data));
    }

    if (!this.id) {
      if (!this.data.created_by && this.context.user_id) this.set('created_by', this.context.user_id);
      if (!this.data.owner_id   && this.context.user_id) this.set('owner_id',   this.context.user_id);
      if (!this.data.status)                             this.set('status', 'draft');

      // Resolve template contract on insert
      const templateRef = this.data.template_id;
      if (templateRef) {
        const contract = await TemplateResolver.resolve(templateRef);
        if (contract) {
          if (contract.domain_id && !this.data.domain_id) {
            this.set('domain_id', contract.domain_id);
          }
          // Apply contract defaults — don't override explicitly provided values
          for (const [key, value] of Object.entries(contract.defaults || {})) {
            if (this.data[key] === undefined || this.data[key] === null) {
              this.set(key, value);
            }
          }
        }
      }
    } else {
      this.set('updated_at', new Date().toISOString());
      if (this.context.user_id) this.set('updated_by', this.context.user_id);
    }
  }

  // ── Domain methods ─────────────────────────────────────────────────────────

  async publish() {
    this.assign({ status: 'published', published_at: new Date().toISOString() });
    return this.save();
  }

  async archive() {
    this.assign({ inactive: true });
    return this.save();
  }

  async addMedia(mediaData) {
    const ArtifactMedia = require('./ArtifactMedia');
    const m = new ArtifactMedia({ artifact_id: this.id, ...mediaData }, { context: this.context, meta: this.meta });
    return m.save();
  }

  async relate(targetId, relationType, meta = {}) {
    const ArtifactRelation = require('./ArtifactRelation');
    const r = new ArtifactRelation(
      { source_artifact_id: this.id, target_artifact_id: targetId, relation_type: relationType, metadata: meta },
      { context: this.context, meta: this.meta },
    );
    return r.save();
  }

  // ── Static helpers ─────────────────────────────────────────────────────────

  // Returns the store's ephemera ark ID, creating it lazily if needed.
  // Ephemera is the default container for artifacts not placed in a specific ark.
  static async getOrCreateEphemera(ctx) {
    if (!ctx.store_id) return null;

    const { data } = await Artifact.db
      .from('artifacts')
      .select('id')
      .eq('store_id', ctx.store_id)
      .eq('artifact_type', 'ark')
      .eq('slug', 'ephemera')
      .maybeSingle();

    if (data?.id) return data.id;

    try {
      const ark = new Artifact({
        artifact_type: 'ark',
        title:         'Ephemera',
        slug:          'ephemera',
        summary:       'Unattached artifacts.',
        status:        'published',
        context:       { is_ephemera: true, visibility: 'private' },
      }, { context: ctx });
      await ark.save();
      return ark.id;
    } catch {
      // Race condition: another request created it first — retry lookup
      const { data: retry } = await Artifact.db
        .from('artifacts')
        .select('id')
        .eq('store_id', ctx.store_id)
        .eq('artifact_type', 'ark')
        .eq('slug', 'ephemera')
        .maybeSingle();
      return retry?.id || null;
    }
  }

  // Returns the store's archive ark ID, creating it lazily if needed —
  // same singleton pattern as getOrCreateEphemera. Distinct from Ephemera:
  // Ephemera is where an artifact lands by default when never explicitly
  // placed anywhere; Archive is an explicit destination someone moves
  // something TO, on purpose, when it's been reviewed and doesn't belong
  // in an active gallery/catalog Ark but shouldn't be deleted either.
  static async getOrCreateArchive(ctx) {
    if (!ctx.store_id) return null;

    const { data } = await Artifact.db
      .from('artifacts')
      .select('id')
      .eq('store_id', ctx.store_id)
      .eq('artifact_type', 'ark')
      .eq('slug', 'archive')
      .maybeSingle();

    if (data?.id) return data.id;

    try {
      const ark = new Artifact({
        artifact_type: 'ark',
        title:         'Archive',
        slug:          'archive',
        summary:       'Reviewed, kept, not in active use.',
        status:        'published',
        // memchart_slug — see ark/memcharts/archive/memchart.yaml, registered
        // via PipelineRegistry.registerMemchartFile. Declares what "archived"
        // means and how a future cleanup pass should treat this Ark's
        // contents; no such pass exists yet, this just gives one somewhere
        // real to start from instead of inventing policy from scratch.
        context:       { is_archive: true, visibility: 'private', memchart_slug: 'archive' },
      }, { context: ctx });
      await ark.save();
      return ark.id;
    } catch {
      // Race condition: another request created it first — retry lookup
      const { data: retry } = await Artifact.db
        .from('artifacts')
        .select('id')
        .eq('store_id', ctx.store_id)
        .eq('artifact_type', 'ark')
        .eq('slug', 'archive')
        .maybeSingle();
      return retry?.id || null;
    }
  }

  // ── Static finders ─────────────────────────────────────────────────────────

  // Returns an Artifact instance or null. Always scopes to store_id.
  // Private artifacts are only resolved for rank>=100 (site admin/owner —
  // same threshold _authz.js's assertOwnerOrAdmin already uses for "may
  // modify anything"). Was gated on ctx.role === 'GUEST' only, meaning ANY
  // authenticated account — including a plain rank-10 USER customer, not
  // just staff — bypassed it entirely and saw every private ark (confirmed
  // live: a real customer test account could see and open all of them).
  // A private id under an insufficient-rank ctx comes back null, same as a
  // nonexistent one — doesn't leak existence.
  static async findById(id, ctx = {}) {
    if (!id) return null;
    let q = Artifact.db.from('artifacts').select('*').eq('id', id);
    if (ctx.store_id) q = q.eq('store_id', ctx.store_id);
    if ((ctx.rank ?? 0) < 100) q = q.eq('context->>visibility', 'public');
    const { data, error } = await q.single();
    if (error || !data) return null;
    return new Artifact(data, { context: ctx });
  }

  // Returns plain data objects (not instances) for list responses.
  // See findById's comment — same rank-gated visibility enforcement applies here.
  static _isVisibleArtifact(row) {
    return !!row && row.inactive !== true;
  }

  // includeDisplayedPrivate — opt-in, off by default. A private artifact
  // can additionally set context.display:true to say "show my existence
  // (title/cover) as a locked splash, just never my actual content" —
  // distinct from visibility, which gates content access outright (see
  // findById). Only ArkActions.list() passes this; every other caller of
  // query() keeps the strict public-only behavior for a low-rank viewer,
  // so this splash concept doesn't leak into artifact types that never
  // asked for it.
  static async query({
    artifact_type, status, tag_keys, inactive = false,
    limit = 50, select, order, filters = [], includeDisplayedPrivate = false,
  } = {}, ctx = {}) {
    let q = Artifact.db
      .from('artifacts')
      .select(select || 'id, artifact_type, title, slug, summary, status, context, tag_keys, metadata, created_at, updated_at')
      .eq('inactive', inactive)
      .order(order?.column || 'updated_at', { ascending: order?.ascending ?? false })
      .limit(limit);

    if (ctx.store_id)   q = q.eq('store_id', ctx.store_id);
    if (artifact_type)  q = q.eq('artifact_type', artifact_type);
    if (status)         q = q.eq('status', status);
    if (tag_keys?.length) q = q.overlaps('tag_keys', tag_keys);
    if ((ctx.rank ?? 0) < 100) {
      q = includeDisplayedPrivate
        ? q.or("context->>visibility.eq.public,and(context->>visibility.eq.private,context->>display.eq.true)")
        : q.eq('context->>visibility', 'public');
    }
    for (const [col, op, val] of filters) q = q.filter(col, op, val);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// SHA-256 of the canonical content fields — excludes runtime/storage metadata
// so two Arks independently produce the same hash for identical knowledge.
function _packetFingerprint(data) {
  const canonical = {
    artifact_type: data.artifact_type || null,
    domain_id:     data.domain_id     || null,
    template_id:   data.template_id   || null,
    title:         data.title         || null,
    body:          data.body          || null,
    summary:       data.summary       || null,
    tag_keys:      [...(data.tag_keys || [])].sort(),
    metadata:      data.metadata      || {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = Artifact;
module.exports._internals = { _packetFingerprint, _isVisibleArtifact: Artifact._isVisibleArtifact };
