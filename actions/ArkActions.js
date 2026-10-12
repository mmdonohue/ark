const Artifact         = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const TemplateResolver = require('../core/TemplateResolver');
const { toSlug }       = require('../domain/slug');
const { pickDisplayableImage, imageSrcFor, isDisplayableImage } = require('../domain/mediaDisplay');
const { assertOwnerOrAdmin } = require('./_authz');

async function resolveSlug(storeId, base) {
  const { data: existing } = await Artifact.db
    .from('artifacts')
    .select('slug')
    .eq('store_id', storeId)
    .like('slug', `${base}%`);

  if (!existing?.length) return base;
  const taken = new Set(existing.map(r => r.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

async function create(ctx, payload, packet) {
  const {
    title, summary, visibility = 'private', is_arc = false,
    tag_keys = [], metadata = {},
    template_id,
  } = payload;
  if (!title) throw new Error('title is required');

  let contract = null;
  if (template_id) {
    contract = await TemplateResolver.resolve(template_id);
    if (!contract) throw new Error(`Template not found: ${template_id}`);
  }

  const slug = await resolveSlug(ctx.store_id, toSlug(title));

  const ark = new Artifact({
    artifact_type: 'ark',
    title,
    slug,
    summary:      summary || null,
    tag_keys,
    metadata,
    template_id:  template_id || null,
    domain_id:    contract?.domain_id || null,
    context:      { visibility, is_arc },
  }, { context: ctx });

  await ark.save();

  if (template_id) {
    const rel = new ArtifactRelation({
      source_artifact_id: ark.id,
      target_artifact_id: template_id,
      relation_type:      'uses_template',
    }, { context: ctx });
    await rel.save();
  }

  packet._objects['ark'] = ark.data;
  packet.log.push(`ark.create → ${ark.id} "${title}"${contract ? ` [${contract.slug || template_id}]` : ''}`);

  return { data: { ark: ark.data } };
}

async function list(ctx, payload, packet) {
  const { status, tag_keys, template_id: filterTemplateId } = payload;
  const filters = filterTemplateId ? [['template_id', 'eq', filterTemplateId]] : [];

  const arks = await Artifact.query({ artifact_type: 'ark', status, tag_keys, inactive: false, filters, includeDisplayedPrivate: true }, ctx);

  // Flags a private-but-displayed ark for the frontend so it renders as a
  // locked splash (title/cover only, not clickable through to content) —
  // members/count below are still resolved normally for it since that's
  // cheap and harmless, but the frontend should ignore them for a
  // restricted card.
  for (const ark of arks) ark.restricted = ark.context?.visibility === 'private';

  if (arks.length) {
    const arkIds = arks.map(a => a.id);
    // 'contains' relation, entry_relation for the common case — a template
    // with a different entry_relation (rare, see ark.get) just falls back
    // to no count/cover for that one Ark rather than a second resolve pass
    // per Ark here; the listing is a lightweight summary, not the full get.
    const { data: rels } = await Artifact.db
      .from('artifact_relations')
      .select('source_artifact_id, target_artifact_id, order_index')
      .in('source_artifact_id', arkIds)
      .eq('relation_type', 'contains')
      .order('order_index', { ascending: false });

    const memberIdsByArk = new Map();
    for (const r of (rels || [])) {
      if (!memberIdsByArk.has(r.source_artifact_id)) memberIdsByArk.set(r.source_artifact_id, []);
      memberIdsByArk.get(r.source_artifact_id).push(r.target_artifact_id);
    }

    // "N artifacts" on the card should count what a viewer will actually
    // see, not raw `contains` membership — an archival_master member (a
    // TIFF reference with no bytes at all by design; its viewable JPG
    // pair lives on a SEPARATE member artifact) never renders in the
    // gallery, so counting it just inflates the number past what's
    // visible. Confirmed live: Birds had 54 members, only 30 displayable.
    // Bytes can live in `url` (post-migration) OR still-inline `data_url`
    // (freshly sync.push'd media that hasn't been migrated to Storage
    // yet — confirmed live: a real camera-card import synced today had
    // real photo bytes only in data_url, and omitting it here silently
    // miscounted every one of them as non-displayable). Never select
    // data_url's actual content (can be multi-MB per row) — a second,
    // ids-only query says which rows have one without paying for the
    // payload.
    const allMemberIds = [...new Set([...memberIdsByArk.values()].flat())];
    const displayableByArtifact = new Map();
    if (allMemberIds.length) {
      const [{ data: memberMediaRows }, { data: inlineDataRows }] = await Promise.all([
        Artifact.db
          .from('artifact_media')
          .select('artifact_id, media_type, url, thumbnail_url, metadata')
          .in('artifact_id', allMemberIds),
        Artifact.db
          .from('artifact_media')
          .select('artifact_id')
          .in('artifact_id', allMemberIds)
          .not('data_url', 'is', null),
      ]);
      const hasInlineData = new Set((inlineDataRows || []).map(r => r.artifact_id));

      const imagesByArtifact = new Map();
      for (const m of (memberMediaRows || [])) {
        if (m.media_type !== 'image') continue;
        if (!imagesByArtifact.has(m.artifact_id)) imagesByArtifact.set(m.artifact_id, []);
        imagesByArtifact.get(m.artifact_id).push(m);
      }
      for (const id of allMemberIds) {
        const images = imagesByArtifact.get(id);
        // No image media at all -> a text/note member, still shows as its
        // own tile (same "text-only always shows" rule Grid.tsx's client-
        // side filter already applies). isDisplayableImage checks data_url
        // too, but we never loaded its content here — hasInlineData(id)
        // stands in for "would data_url be truthy" without paying for it.
        const displayable = !images || images.length === 0 || images.some(m =>
          isDisplayableImage(m) || (m.metadata?.representation_role !== 'archival_master' && hasInlineData.has(m.artifact_id)));
        displayableByArtifact.set(id, displayable);
      }
    }

    // Cover resolution only ever needs media for, at most, TWO ids per
    // Ark: its cover_artifact_id pointer, or its own direct media (legacy
    // splash) — falling back to checking members only when NEITHER
    // exists. The previous version bulk-fetched every member's media
    // (including full inline data_url bytes, sometimes several MB each)
    // for every Ark regardless of whether a pointer already resolved it —
    // a listing endpoint pulling tens of megabytes just to pick one
    // thumbnail per Ark (measured live: 82 rows, 37MB, ~6s, once real
    // photo imports grew the data). Fetching pointer/own-media first and
    // only paying the members-wide cost for Arks that still need it after
    // that keeps this proportional to what's actually missing a cover,
    // not to the total size of every Ark's contents.
    const pointerIds = arks.map(a => a.metadata?.cover_artifact_id).filter(Boolean);
    const ownMediaIds = [...new Set([...arkIds, ...pointerIds])];
    const mediaByArtifact = new Map();
    if (ownMediaIds.length) {
      const { data: mediaRows } = await Artifact.db
        .from('artifact_media')
        .select('artifact_id, media_type, url, thumbnail_url, data_url, metadata')
        .in('artifact_id', ownMediaIds);
      for (const m of (mediaRows || [])) {
        if (!mediaByArtifact.has(m.artifact_id)) mediaByArtifact.set(m.artifact_id, []);
        mediaByArtifact.get(m.artifact_id).push(m);
      }
    }

    const needsMemberFallback = [];
    for (const ark of arks) {
      const memberIds = memberIdsByArk.get(ark.id) || [];
      ark.artifact_count = memberIds.filter(id => displayableByArtifact.get(id)).length;

      // The cover is a pointer at a real member artifact (metadata.
      // cover_artifact_id) — no second copy of the splash bytes stored on
      // the Ark itself. An orphaned pointer just falls through to the
      // legacy/first-member fallbacks below.
      const coverArtifactId = ark.metadata?.cover_artifact_id || null;
      const coverPick = coverArtifactId ? pickDisplayableImage(mediaByArtifact.get(coverArtifactId)) : null;
      if (coverPick) {
        ark.cover_image = imageSrcFor(coverPick);
        continue;
      }

      // Legacy fallback — Arks whose splash was set before the pointer
      // model, storing the photo directly on the Ark's own artifact_media.
      const ownCover = pickDisplayableImage(mediaByArtifact.get(ark.id));
      if (ownCover) {
        ark.cover_image = imageSrcFor(ownCover);
        continue;
      }

      ark.cover_image = null;
      if (memberIds.length) needsMemberFallback.push(ark);
    }

    // Only the Arks that got through the above with no cover pay for a
    // members-wide media fetch — and only for their own members, not
    // every Ark's. Even then, bounded to each Ark's first few members
    // (memberIdsByArk is already order_index-sorted, same visual order
    // ark.get uses) rather than every one of them — a gallery with dozens
    // of members (Birds has 54) doesn't need all of their inline photo
    // bytes fetched just to find the first displayable one. A small
    // headroom past 1 covers the case where the very first member turns
    // out non-displayable (e.g. an archival_master-only TIFF).
    const FALLBACK_COVER_CANDIDATES = 5;
    if (needsMemberFallback.length) {
      const fallbackMemberIds = [...new Set(
        needsMemberFallback.flatMap(ark => (memberIdsByArk.get(ark.id) || []).slice(0, FALLBACK_COVER_CANDIDATES))
      )];
      const { data: memberMediaRows } = await Artifact.db
        .from('artifact_media')
        .select('artifact_id, media_type, url, thumbnail_url, data_url, metadata')
        .in('artifact_id', fallbackMemberIds);
      const memberMediaByArtifact = new Map();
      for (const m of (memberMediaRows || [])) {
        if (!memberMediaByArtifact.has(m.artifact_id)) memberMediaByArtifact.set(m.artifact_id, []);
        memberMediaByArtifact.get(m.artifact_id).push(m);
      }
      for (const ark of needsMemberFallback) {
        for (const memberId of (memberIdsByArk.get(ark.id) || []).slice(0, FALLBACK_COVER_CANDIDATES)) {
          const img = pickDisplayableImage(memberMediaByArtifact.get(memberId));
          if (img) { ark.cover_image = imageSrcFor(img); break; }
        }
      }
    }
  }

  // Public arks first, then private/ephemera — sort is stable, so each
  // group keeps its existing updated_at-desc order. Otherwise a logged-in
  // admin's authenticated list (unlike the anonymous SSR pass, which only
  // ever sees public arks) mixes recently-touched private/test arks in by
  // recency alone, so they jump to the front right after the public-only
  // SSR list already painted — the exact reorder-after-load flicker this
  // avoids.
  arks.sort((a, b) => {
    const aPub = a.context?.visibility === 'public' ? 0 : 1;
    const bPub = b.context?.visibility === 'public' ? 0 : 1;
    return aPub - bPub;
  });

  packet.log.push(`ark.list → ${arks.length} results`);
  return { data: { arks } };
}

async function get(ctx, payload, packet) {
  const { ark_id } = payload;
  if (!ark_id) throw new Error('ark_id is required');

  const ark = await Artifact.findById(ark_id, ctx);
  if (!ark) {
    // findById already enforces the real access gate (rank>=100 or
    // public) — this is a narrow UX exception on top of it, not a second
    // enforcement point: a private ark that opted into context.display
    // shows a locked splash (title/cover only) instead of a flat 404,
    // same idea as list()'s restricted flag. A SEPARATE, minimal query on
    // purpose — never fetches members/relations/media for a restricted
    // ark, so no real content is ever touched for a viewer who can't see it.
    if ((ctx.rank ?? 0) < 100) {
      let q = Artifact.db.from('artifacts')
        .select('id, title, slug, context, metadata')
        .eq('id', ark_id).eq('artifact_type', 'ark')
        .eq('context->>display', 'true');
      if (ctx.store_id) q = q.eq('store_id', ctx.store_id);
      const { data: splash } = await q.maybeSingle();
      if (splash) {
        return { data: { restricted: true, ark: splash } };
      }
    }
    throw Object.assign(new Error('Ark not found'), { status: 404 });
  }

  const templateId = ark.get('template_id') || ark.get('context')?.template_id;

  let contract  = null;
  let templateRow = null;
  if (templateId) {
    [contract] = await Promise.all([TemplateResolver.resolve(templateId)]);
    if (contract) {
      const { data: tmpl } = await Artifact.db
        .from('artifacts')
        .select('*')
        .eq('id', contract.id)
        .single();
      templateRow = tmpl;
    }
  }

  const entryRelation = contract?.entry_relation || 'contains';

  const { data: rels } = await Artifact.db
    .from('artifact_relations')
    .select('target_artifact_id, order_index, artifacts!target_artifact_id(*)')
    .eq('source_artifact_id', ark_id)
    .eq('relation_type', entryRelation)
    .order('order_index', { ascending: true });

  let artifacts = (rels || [])
    .map(r => ({ ...r.artifacts, order_index: r.order_index }))
    .filter(Artifact._isVisibleArtifact);

  if (artifacts.length) {
    const ids = artifacts.map(a => a.id);
    const { data: allMedia } = await Artifact.db
      .from('artifact_media')
      .select('*')
      .in('artifact_id', ids)
      .order('sort_order', { ascending: true });

    const mediaMap = {};
    (allMedia || []).forEach(m => {
      if (!mediaMap[m.artifact_id]) mediaMap[m.artifact_id] = [];
      mediaMap[m.artifact_id].push(m);
    });

    artifacts = artifacts.map(a => ({ ...a, media: mediaMap[a.id] || [] }));

    // One batched query for every member's like count (event-sourced — see
    // ArtifactActions.toggleLike), same batching principle as the media
    // fetch just above: a per-tile round trip would be N queries for an
    // N-artifact gallery instead of one.
    const { data: likeEvents } = await Artifact.db
      .from('artifact_events')
      .select('artifact_id, event_type')
      .in('artifact_id', ids)
      .in('event_type', ['artifact.liked', 'artifact.unliked']);

    const likeCounts = {};
    for (const e of likeEvents || []) {
      likeCounts[e.artifact_id] = (likeCounts[e.artifact_id] || 0) + (e.event_type === 'artifact.liked' ? 1 : -1);
    }
    artifacts = artifacts.map(a => ({ ...a, like_count: likeCounts[a.id] || 0 }));

    // One-level "series -> individual pieces" flatten data (see
    // .claude/plans/ark/ui_resolution_contracts.md's own Sculpture/Totem-
    // Pair/Unit example) — each member's OWN 'contains' children, batched
    // the same way media/likes just above are. Purely presentational: the
    // real Ark membership is still only the `artifacts` list itself; the
    // frontend decides whether/how to render a member's children alongside
    // it. Not recursive — only one level deep.
    const { data: childRels } = await Artifact.db
      .from('artifact_relations')
      .select('source_artifact_id, target_artifact_id, order_index')
      .in('source_artifact_id', ids)
      .eq('relation_type', 'contains')
      .order('order_index', { ascending: true });

    if (childRels?.length) {
      const childIds = [...new Set(childRels.map(r => r.target_artifact_id))];
      const [{ data: childRows }, { data: childMedia }, { data: childLikeEvents }] = await Promise.all([
        Artifact.db.from('artifacts').select('*').in('id', childIds).eq('inactive', false),
        Artifact.db.from('artifact_media').select('*').in('artifact_id', childIds).order('sort_order', { ascending: true }),
        Artifact.db.from('artifact_events').select('artifact_id, event_type').in('artifact_id', childIds).in('event_type', ['artifact.liked', 'artifact.unliked']),
      ]);

      const childMediaMap = {};
      (childMedia || []).forEach(m => {
        if (!childMediaMap[m.artifact_id]) childMediaMap[m.artifact_id] = [];
        childMediaMap[m.artifact_id].push(m);
      });

      const childLikeCounts = {};
      for (const e of childLikeEvents || []) {
        childLikeCounts[e.artifact_id] = (childLikeCounts[e.artifact_id] || 0) + (e.event_type === 'artifact.liked' ? 1 : -1);
      }

      const childRowMap = {};
      (childRows || []).forEach(c => {
        childRowMap[c.id] = { ...c, media: childMediaMap[c.id] || [], like_count: childLikeCounts[c.id] || 0 };
      });

      const childrenByParent = {};
      for (const rel of childRels) {
        const child = childRowMap[rel.target_artifact_id];
        if (!child) continue;
        if (!childrenByParent[rel.source_artifact_id]) childrenByParent[rel.source_artifact_id] = [];
        childrenByParent[rel.source_artifact_id].push({ ...child, order_index: rel.order_index });
      }

      artifacts = artifacts.map(a => ({ ...a, children: childrenByParent[a.id] || [] }));
    } else {
      artifacts = artifacts.map(a => ({ ...a, children: [] }));
    }
  }

  // Same priority ark.list uses for its listing tiles, so the detail page
  // header and the listing agree on what "the cover" is:
  //   1. metadata.cover_artifact_id — a pointer at a real member artifact
  //      (the current model: uploading/choosing a splash creates or reuses
  //      a grid member rather than storing a second copy of the bytes on
  //      the Ark itself).
  //   2. the Ark's own artifact_media — legacy fallback for Arks whose
  //      splash was set before the pointer model existed.
  //   3. the first member (already in visual order) with a displayable
  //      image — reusing the member .media already fetched above.
  ark.data.cover_image = null;

  const coverArtifactId = ark.get('metadata')?.cover_artifact_id || null;
  if (coverArtifactId) {
    const coverMember = artifacts.find(a => a.id === coverArtifactId);
    const coverMedia = coverMember
      ? coverMember.media
      : (await Artifact.db
          .from('artifact_media')
          .select('media_type, url, thumbnail_url, data_url, metadata')
          .eq('artifact_id', coverArtifactId)
        ).data;
    const coverPick = pickDisplayableImage(coverMedia);
    if (coverPick) ark.data.cover_image = imageSrcFor(coverPick);
  }

  if (!ark.data.cover_image) {
    const { data: ownMedia } = await Artifact.db
      .from('artifact_media')
      .select('media_type, url, thumbnail_url, data_url, metadata')
      .eq('artifact_id', ark_id);
    const ownCover = pickDisplayableImage(ownMedia);
    if (ownCover) ark.data.cover_image = imageSrcFor(ownCover);
  }

  if (!ark.data.cover_image) {
    for (const member of artifacts) {
      const img = pickDisplayableImage(member.media);
      if (img) { ark.data.cover_image = imageSrcFor(img); break; }
    }
  }

  // Cinema reel (see CinemaRenderActions.renderReel) — stored as video
  // media directly on the Ark itself, same place a legacy splash lived
  // before the pointer model. Each render adds a new row rather than
  // replacing the last one, so surface the most recent — lets the Ark page
  // show "already rendered, here's the link" instead of only ever showing
  // a result right after clicking Render, in the same session.
  const { data: reelMedia } = await Artifact.db
    .from('artifact_media')
    .select('url, created_at, file_size')
    .eq('artifact_id', ark_id)
    .eq('media_type', 'video')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  ark.data.reel_url = reelMedia?.url || null;
  ark.data.reel_created_at = reelMedia?.created_at || null;
  ark.data.reel_file_size = reelMedia?.file_size || null;

  // Compose → Publish → Revisit: a "New gallery"/"Cinema" publish creates a
  // whole separate Ark referencing the same artifacts (see
  // publishSelectionAsGallery in pages/arks/[id].tsx) — without recording
  // this, there was no way back to it short of remembering its name and
  // finding it in the main Arks list. published_to is the relation that
  // link records; this hydrates just enough (id/title/cover) to render a
  // small revisit card, same cover-priority as the Ark's own (pointer →
  // legacy own-media), scoped to this handful of rows rather than a full
  // second ark.get per entry.
  const { data: publishedRels } = await Artifact.db
    .from('artifact_relations')
    .select('target_artifact_id, metadata, artifacts!target_artifact_id(id, title, metadata)')
    .eq('source_artifact_id', ark_id)
    .eq('relation_type', 'published_to')
    .order('created_at', { ascending: false });

  let published = [];
  if (publishedRels?.length) {
    const pubTargets = publishedRels.map(r => r.artifacts).filter(Boolean);
    const coverPointerIds = pubTargets.map(a => a.metadata?.cover_artifact_id).filter(Boolean);
    const neededIds = [...new Set([...pubTargets.map(a => a.id), ...coverPointerIds])];

    const { data: pubMedia } = await Artifact.db
      .from('artifact_media')
      .select('artifact_id, media_type, url, thumbnail_url, data_url, metadata')
      .in('artifact_id', neededIds);
    const pubMediaMap = {};
    (pubMedia || []).forEach(m => {
      if (!pubMediaMap[m.artifact_id]) pubMediaMap[m.artifact_id] = [];
      pubMediaMap[m.artifact_id].push(m);
    });

    published = publishedRels
      .filter(r => r.artifacts)
      .map(r => {
        const target = r.artifacts;
        const coverPointerId = target.metadata?.cover_artifact_id;
        const coverPick = (coverPointerId && pickDisplayableImage(pubMediaMap[coverPointerId]))
          || pickDisplayableImage(pubMediaMap[target.id]);
        return {
          id: target.id,
          title: target.title,
          destination: r.metadata?.destination || null,
          cover_image: coverPick ? imageSrcFor(coverPick) : null,
        };
      });
  }

  packet._objects['ark'] = ark.data;
  if (templateRow) packet._objects['template'] = templateRow;
  packet.log.push(`ark.get → ${ark_id}, ${artifacts.length} entries, ${published.length} published`);

  return { data: { ark: ark.data, template: templateRow, contract, artifacts, published } };
}

// ── ark.graph — the artifact_relations neighborhood, not just `contains` ──
// ark.get only ever returns the Ark's own contains list (a template
// contract's entry_relation, in fact) — this is the raw 1-hop graph: every
// relation touching the Ark itself, plus every relation among its direct
// neighbors (so e.g. a `supersedes` chain between two member artifacts
// shows up, not just their shared membership in the Ark). Same visibility
// gate as ark.get — findById() already enforces GUEST-only-sees-public;
// once the Ark itself passes that gate, showing its neighborhood is
// consistent with what ark.get already does for `contains` members (see
// the same scope-boundary note there — no per-relation visibility check).
async function graph(ctx, payload, packet) {
  const { ark_id } = payload;
  if (!ark_id) throw new Error('ark_id is required');

  const ark = await Artifact.findById(ark_id, ctx);
  if (!ark) throw Object.assign(new Error('Ark not found'), { status: 404 });

  const { data: outRels } = await Artifact.db.from('artifact_relations').select('*').eq('source_artifact_id', ark_id);
  const { data: inRels }  = await Artifact.db.from('artifact_relations').select('*').eq('target_artifact_id', ark_id);

  const neighborIds = new Set();
  for (const r of [...(outRels || []), ...(inRels || [])]) {
    neighborIds.add(r.source_artifact_id);
    neighborIds.add(r.target_artifact_id);
  }
  neighborIds.delete(ark_id);

  const memberIds = [...neighborIds];
  let memberRels = [];
  if (memberIds.length) {
    const { data } = await Artifact.db
      .from('artifact_relations')
      .select('*')
      .in('source_artifact_id', memberIds)
      .in('target_artifact_id', memberIds);
    memberRels = data || [];
  }

  const allIds = [ark_id, ...memberIds];
  const { data: nodeRows } = await Artifact.db
    .from('artifacts')
    .select('id, artifact_type, title, slug, status, context, summary, created_at, published_at, created_by')
    .in('id', allIds);

  const { data: mediaRows } = await Artifact.db
    .from('artifact_media')
    .select('artifact_id, media_type, url, thumbnail_url, data_url, file_size, metadata')
    .in('artifact_id', allIds);

  const mediaByArtifact = new Map();
  for (const m of (mediaRows || [])) {
    if (!mediaByArtifact.has(m.artifact_id)) mediaByArtifact.set(m.artifact_id, []);
    mediaByArtifact.get(m.artifact_id).push(m);
  }

  const creatorIds = [...new Set((nodeRows || []).map(n => n.created_by).filter(Boolean))];
  const creatorMap = new Map();
  if (creatorIds.length) {
    const { data: creators } = await Artifact.db.from('users').select('id, first_name, last_name, email').in('id', creatorIds);
    for (const c of (creators || [])) {
      creatorMap.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email);
    }
  }

  // media_status distinguishes "has a viewable image" (birds JPGs) from
  // "has media but nothing displayable" (birds TIFFs — archival_master
  // only) from "no image media at all" (arks, templates).
  function mediaInfo(id) {
    const images = (mediaByArtifact.get(id) || []).filter(m => m.media_type === 'image');
    if (!images.length) return { media_status: 'none', thumbnail: null, media_type: null, file_size: null };
    const viewable = pickDisplayableImage(images);
    const rep = viewable || images[0];
    return {
      media_status: viewable ? 'viewable' : 'hidden',
      thumbnail:    imageSrcFor(viewable),
      media_type:   rep.media_type,
      file_size:    rep.file_size ?? null,
    };
  }

  const edgeById = new Map();
  for (const r of [...(outRels || []), ...(inRels || []), ...memberRels]) {
    edgeById.set(r.id, { id: r.id, source: r.source_artifact_id, target: r.target_artifact_id, relation_type: r.relation_type });
  }

  const nodes = (nodeRows || []).map(n => ({
    id: n.id,
    artifact_type: n.artifact_type,
    title: n.title,
    slug: n.slug,
    status: n.status,
    is_root: n.id === ark_id,
    visibility:    n.context?.visibility || 'private',
    summary:       n.summary || null,
    created_at:    n.created_at || null,
    published_at:  n.published_at || null,
    created_by:    n.created_by ? (creatorMap.get(n.created_by) || `user:${n.created_by}`) : null,
    ...mediaInfo(n.id),
  }));
  const edges = [...edgeById.values()];

  packet.log.push(`ark.graph → ${nodes.length} nodes, ${edges.length} edges for ark:${ark_id}`);
  return { data: { nodes, edges } };
}

async function update(ctx, payload, packet) {
  const { ark_id, ...fields } = payload;
  if (!ark_id) throw new Error('ark_id is required');
  await assertOwnerOrAdmin(ctx, ark_id, { label: 'Ark' });

  const allowed = ['title', 'summary', 'body', 'status', 'tag_keys', 'metadata', 'context', 'published_at', 'template_id', 'is_arc'];
  const updates = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) throw new Error('No updatable fields provided');
  if (updates.title && !updates.slug) updates.slug = toSlug(updates.title);

  // Changing type after creation — re-resolve domain_id to match the new
  // template, same as ark.create does at insert time, so it doesn't stay
  // stale/mismatched. Doesn't retroactively apply the new template's
  // `defaults` (Artifact.prepare()'s defaults-application is scoped to
  // insert only, not update) — changing type shouldn't silently overwrite
  // fields already customized.
  if ('template_id' in updates) {
    const contract = updates.template_id ? await TemplateResolver.resolve(updates.template_id) : null;
    updates.domain_id = contract?.domain_id || null;
  }

  // metadata/context are JSONB columns updated via a plain column
  // overwrite (Packet.save() writes dirty fields as-is, no jsonb_set/||) —
  // shallow-merge the caller's partial update onto the current value so a
  // caller setting one key (e.g. metadata.subtitle) doesn't silently wipe
  // every other key already stored there.
  if (updates.metadata || updates.context || 'is_arc' in updates) {
    const { data: current } = await Artifact.db
      .from('artifacts').select('metadata, context').eq('id', ark_id).single();
    if (updates.metadata) updates.metadata = { ...(current?.metadata || {}), ...updates.metadata };
    if (updates.context)  updates.context  = { ...(current?.context  || {}), ...updates.context };
    if ('is_arc' in updates) {
      updates.context = { ...(current?.context || {}), ...(updates.context || {}), is_arc: updates.is_arc };
      delete updates.is_arc;
    }
  }

  const ark = new Artifact({ id: ark_id }, { context: ctx });
  ark.assign(updates);
  await ark.save();

  packet._objects['ark'] = ark.data;
  packet.log.push(`ark.update → ${ark_id}`);

  return { data: { ark: ark.data } };
}

async function archive(ctx, payload, packet) {
  const { ark_id } = payload;
  if (!ark_id) throw new Error('ark_id is required');
  await assertOwnerOrAdmin(ctx, ark_id, { label: 'Ark' });

  const ark = new Artifact({ id: ark_id }, { context: ctx });
  await ark.archive();

  packet.log.push(`ark.archive → ${ark_id}`);
  return { data: { ark: ark.data } };
}

async function addArtifact(ctx, payload, packet) {
  const { ark_id, artifact_id, copied_from_ark_id } = payload;
  if (!ark_id || !artifact_id) throw new Error('ark_id and artifact_id are required');
  // Only the destination Ark's ownership matters — the artifact being
  // referenced doesn't need to be owned by the caller (that's the whole
  // point of Copy/Publish: referencing something you can already see into
  // an Ark you own).
  await assertOwnerOrAdmin(ctx, ark_id, { label: 'Ark' });

  const { data: arkRow } = await Artifact.db
    .from('artifacts')
    .select('template_id, context')
    .eq('id', ark_id)
    .single();

  let entryRelation = 'contains';
  const arkTemplateId = arkRow?.template_id || arkRow?.context?.template_id;
  if (arkTemplateId) {
    const contract = await TemplateResolver.resolve(arkTemplateId);
    entryRelation = contract?.entry_relation || 'contains';
  }

  // Idempotent on an already-existing membership — load-bearing now that
  // this is also what "Copy" (ark.add_artifact with no removal) and
  // Archive (ark.move_artifact's to_archive shorthand) both call directly.
  // An artifact copied into two Arks and later archived from each in turn
  // hits this exact case the second time: already a member of Archive by
  // the time the second archive call runs. Without this check that's a
  // raw unique-constraint violation surfaced as a confusing 500, for
  // something that isn't really an error — the artifact IS already where
  // the caller wanted it.
  const { data: existingRel } = await Artifact.db
    .from('artifact_relations')
    .select('*')
    .eq('source_artifact_id', ark_id)
    .eq('target_artifact_id', artifact_id)
    .eq('relation_type', entryRelation)
    .maybeSingle();
  if (existingRel) {
    packet._objects['relation'] = existingRel;
    packet.log.push(`ark.add_artifact → artifact:${artifact_id} already in ark:${ark_id} (no-op)`);
    return { data: { relation: existingRel } };
  }

  const order_index = (await ArtifactRelation.maxOrderIndex(ark_id, entryRelation)) + 1;

  // Same provenance philosophy as move's moved_from edge, mirrored for the
  // opposite direction: Copy doesn't touch the source relation at all (it
  // stays a real, active member there — nothing to preserve, nothing was
  // deleted), so what's missing is a record on the NEW relation of where
  // IT came from. copied_from_ark_id is optional and only ever set by the
  // frontend's explicit Copy action — a plain "add this to an Ark" call
  // (creating a brand-new artifact, attaching an existing one for the
  // first time) has no "source" to record and correctly gets no metadata.
  const metadata = copied_from_ark_id ? { copied_from_ark_id, copied_at: new Date().toISOString() } : {};

  const rel = new ArtifactRelation({
    source_artifact_id: ark_id,
    target_artifact_id: artifact_id,
    relation_type:      entryRelation,
    order_index,
    metadata,
  }, { context: ctx });

  await rel.save();

  packet._objects['relation'] = rel.data;
  packet.log.push(`ark.add_artifact → artifact:${artifact_id} → ark:${ark_id} @ ${order_index}`);

  return { data: { relation: rel.data } };
}

async function removeArtifact(ctx, payload, packet) {
  const { ark_id, artifact_id } = payload;
  if (!ark_id || !artifact_id) throw new Error('ark_id and artifact_id are required');
  await assertOwnerOrAdmin(ctx, ark_id, { label: 'Ark' });

  await ArtifactRelation.deleteWhere({ source_id: ark_id, target_id: artifact_id });

  packet.log.push(`ark.remove_artifact → artifact:${artifact_id} ← ark:${ark_id}`);
  return { data: { ok: true } };
}

async function moveArtifact(ctx, payload, packet) {
  const { from_ark_id, to_ark_id: explicitToArkId, to_archive, artifact_id } = payload;
  if (!from_ark_id || !artifact_id) throw new Error('from_ark_id and artifact_id are required');
  if (!explicitToArkId && !to_archive) throw new Error('to_ark_id (or to_archive: true) is required');
  await assertOwnerOrAdmin(ctx, from_ark_id, { label: 'Ark' });

  // to_archive is a one-click shorthand — the frontend's quick Archive
  // button doesn't need to look up an Ark id first, it just gets created
  // lazily on first use, same as Ephemera. Mutually resolved: an explicit
  // to_ark_id always wins if both were somehow sent.
  const to_ark_id = explicitToArkId || await Artifact.getOrCreateArchive(ctx);
  if (from_ark_id === to_ark_id) throw new Error('from_ark_id and to_ark_id must differ');

  // Add to the destination FIRST — if this fails (e.g. bad to_ark_id), the
  // artifact is untouched in its current Ark, nothing is lost. Only once the
  // new relation is confirmed do we drop the old one, so a mid-move failure
  // leaves the artifact double-linked (visible in both) rather than orphaned.
  const addResult = await addArtifact(ctx, { ark_id: to_ark_id, artifact_id }, packet);
  await _recordMoveProvenance(ctx, { from_ark_id, to_ark_id, artifact_id });

  packet.log.push(`ark.move_artifact → artifact:${artifact_id} : ark:${from_ark_id} → ark:${to_ark_id}`);
  return { data: { relation: addResult.data.relation, ark_id: to_ark_id } };
}

// Converts the old membership edge into provenance instead of deleting it
// outright — "move" should still know its source, same "preserve, don't
// destroy" rule this codebase already applies to source media/metadata
// elsewhere (content-hash fingerprints, published_to, etc.). relation_type
// flips from whatever it was (usually 'contains') to 'moved_from', so
// ark.get's member list (which filters on the active entry_relation) no
// longer counts it as a current member, but the edge itself survives —
// ark.graph is relation-type-agnostic, so it shows up there as a real
// lineage fact: "this artifact used to live in that Ark."
//
// (source_artifact_id, target_artifact_id, relation_type) is uniquely
// constrained, so converting can collide if the artifact was ALREADY
// moved_from this exact same from_ark_id once before (i.e. it went back
// into that Ark and got moved out again) — vanishingly rare in practice.
// On that collision, drop the older moved_from edge and record the newer
// one; only the most recent hop through that specific Ark is kept, not
// every past visit, which is an acceptable trade for not needing a second
// table just to log repeat entries into the same Ark.
async function _recordMoveProvenance(ctx, { from_ark_id, to_ark_id, artifact_id }) {
  const { data: existing } = await Artifact.db
    .from('artifact_relations')
    .select('id, metadata')
    .eq('source_artifact_id', from_ark_id)
    .eq('target_artifact_id', artifact_id);

  for (const rel of existing || []) {
    const { error } = await Artifact.db
      .from('artifact_relations')
      .update({
        relation_type: 'moved_from',
        metadata: { ...(rel.metadata || {}), moved_to_ark_id: to_ark_id, moved_at: new Date().toISOString() },
      })
      .eq('id', rel.id);

    if (error) {
      // Unique-constraint collision — a moved_from edge for this exact
      // (from_ark_id, artifact_id) pair already exists from an earlier
      // move. Drop it and retry once so the newer hop wins.
      await Artifact.db.from('artifact_relations').delete()
        .eq('source_artifact_id', from_ark_id).eq('target_artifact_id', artifact_id).eq('relation_type', 'moved_from');
      await Artifact.db.from('artifact_relations')
        .update({ relation_type: 'moved_from', metadata: { ...(rel.metadata || {}), moved_to_ark_id: to_ark_id, moved_at: new Date().toISOString() } })
        .eq('id', rel.id);
    }
  }
}

async function reorderArtifacts(ctx, payload, packet) {
  const { ark_id, order } = payload;
  if (!ark_id || !Array.isArray(order)) throw new Error('ark_id and order[] are required');
  await assertOwnerOrAdmin(ctx, ark_id, { label: 'Ark' });

  const updates = order.map(({ artifact_id, order_index }) =>
    Artifact.db
      .from('artifact_relations')
      .update({ order_index })
      .eq('source_artifact_id', ark_id)
      .eq('target_artifact_id', artifact_id)
  );

  const results = await Promise.all(updates);
  const failed  = results.find(r => r.error);
  if (failed) throw new Error(failed.error.message);

  packet.log.push(`ark.reorder_artifacts → ${order.length} items in ark:${ark_id}`);
  return { data: { ok: true } };
}

module.exports = { create, list, get, graph, update, archive, addArtifact, removeArtifact, moveArtifact, reorderArtifacts };
