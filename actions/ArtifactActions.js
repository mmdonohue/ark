const crypto            = require('crypto');
const Artifact         = require('../domain/Artifact');
const ArtifactMedia    = require('../domain/ArtifactMedia');
const ArtifactRelation = require('../domain/ArtifactRelation');
const TemplateResolver = require('../core/TemplateResolver');
const { maybeTranscodeHeic } = require('../domain/transcodeHeic');
const { resizeDataUrl }      = require('../domain/resizeImage');
const { imageSize }    = require('image-size');
const { assertOwnerOrAdmin, assertOwnerAdminOrDelegate, RELATION_TYPES } = require('./_authz');
const { getManifest } = require('../core/bootstrap');
const { uploadImageBytes } = require('../domain/mediaStorage');
const { normalizeItemMetadata } = require('../domain/itemMetadata');

async function _recordEvent(ctx, {
  artifact_id,
  event_type,
  event_name,
  payload = {},
  related_artifact_id = null,
  store_id = ctx?.store_id || null,
  actor_id = ctx?.user_id || null,
} = {}) {
  if (!artifact_id || !event_type || !event_name) {
    throw new Error('artifact_id, event_type, and event_name are required');
  }

  const row = {
    store_id: store_id ?? ctx?.store_id ?? 1,
    artifact_id,
    actor_id: actor_id ?? null,
    event_type,
    event_name,
    payload: payload && typeof payload === 'object' ? payload : { value: payload },
    related_artifact_id: related_artifact_id || null,
  };

  const { data, error } = await Artifact.db
    .from('artifact_events')
    .insert(row)
    .select('*')
    .single();

  if (error) throw new Error(error.message || 'Failed to record artifact event');
  return data;
}

async function create(ctx, payload, packet) {
  const {
    artifact_type, title, body, summary, slug,
    visibility = 'private', tag_keys = [], context: ctxFields = {},
    status = 'draft', template_id, store_id,
    ark_id,   // optional — if omitted, artifact is placed in the store's ephemera ark
    // Set by a caller that's about to make its OWN follow-up placement call
    // right after this one (e.g. ArtifactEditor.tsx's handleSave, which
    // create()s then separately artifact.relate()s to a chosen parent) —
    // without this, the artifact would land in Ephemera AND wherever the
    // follow-up call puts it, double-parented. Never set by a caller with
    // no real placement of its own in mind (a bare quick-capture note
    // still wants the Ephemera default).
    skip_default_placement = false,
  } = payload;
  let { metadata = {} } = payload;
  if (!artifact_type) throw new Error('artifact_type is required');
  if (artifact_type === 'item') metadata = normalizeItemMetadata(metadata);

  const artifact = new Artifact({
    artifact_type,
    title:       title       || null,
    slug:        slug        || null,
    body:        body        || null,
    summary:     summary     || null,
    status,
    tag_keys,
    metadata,
    template_id: template_id || null,
    context:     { visibility, ...ctxFields },
    ...(store_id !== undefined ? { store_id } : {}),
  }, { context: ctx });

  await artifact.save();

  // Place in target ark (explicit) or ephemera (default) — unless the
  // caller says it's handling placement itself right after this call.
  const targetArkId = ark_id || (skip_default_placement ? null : await Artifact.getOrCreateEphemera(ctx));
  let placedIn = null;

  if (targetArkId) {
    const order_index = (await ArtifactRelation.maxOrderIndex(targetArkId, 'contains')) + 1;
    const rel = new ArtifactRelation({
      source_artifact_id: targetArkId,
      target_artifact_id: artifact.id,
      relation_type:      'contains',
      order_index,
    }, { context: ctx });
    await rel.save();
    placedIn = targetArkId;
  }

  packet._objects['artifact'] = artifact.data;
  packet._objects[`artifact:${artifact.id}`] = artifact.data;
  packet.log.push(`artifact.create → ${artifact.id} (${artifact_type}) → ark:${placedIn || 'none'}`);

  await _recordEvent(ctx, {
    artifact_id: artifact.id,
    event_type: 'artifact.created',
    event_name: 'Artifact created',
    payload: { artifact_type, status, visibility, title: title || null },
    related_artifact_id: placedIn,
  });

  // Collect workflow hooks and response contract from the resolved template
  let _chain_hooks    = [];
  let _chain_response = null;
  if (artifact.get('template_id')) {
    const contract = await TemplateResolver.resolve(artifact.get('template_id'));
    _chain_hooks    = Array.isArray(contract?.workflow_hooks) ? contract.workflow_hooks : [];
    _chain_response = contract?.response && typeof contract.response === 'object' ? contract.response : null;
  }

  return { data: { artifact: artifact.data, ark_id: placedIn }, _chain_hooks, _chain_response };
}

async function get(ctx, payload, packet) {
  const { artifact_id } = payload;
  if (!artifact_id) throw new Error('artifact_id is required');

  const artifact = await Artifact.findById(artifact_id, ctx);
  if (!artifact) throw Object.assign(new Error('Artifact not found'), { status: 404 });

  const [media, relations, events] = await Promise.all([
    ArtifactMedia.findByArtifact(artifact_id),
    ArtifactRelation.findBySource(artifact_id),
    Artifact.db.from('artifact_events').select('*').eq('artifact_id', artifact_id).order('created_at', { ascending: false }),
  ]);

  const eventRows = events?.data || [];

  // Hydrate full artifact+media rows for 'contains' children — mirrors
  // ArkActions.get's member-hydration (any artifact can be a parent, not
  // just an Ark artifact_type — see artifact.relate) — so a detail page for
  // a plain artifact (e.g. a "Totem Pair" with two unit artifacts under it)
  // can render a photo grid of its own children without a second round
  // trip per child. `relations` above still carries every relation_type
  // raw, for callers that need something other than the display list.
  const containsRels = relations.filter(r => r.relation_type === 'contains');
  let children = [];
  if (containsRels.length) {
    const childIds = containsRels.map(r => r.target_artifact_id);
    const { data: childRows } = await Artifact.db
      .from('artifacts')
      .select('*')
      .in('id', childIds)
      .eq('inactive', false);

    const { data: childMedia } = await Artifact.db
      .from('artifact_media')
      .select('*')
      .in('artifact_id', childIds)
      .order('sort_order', { ascending: true });

    const mediaMap = {};
    (childMedia || []).forEach(m => {
      if (!mediaMap[m.artifact_id]) mediaMap[m.artifact_id] = [];
      mediaMap[m.artifact_id].push(m);
    });

    const orderMap = {};
    containsRels.forEach(r => { orderMap[r.target_artifact_id] = r.order_index; });

    children = (childRows || [])
      .map(c => ({ ...c, media: mediaMap[c.id] || [], order_index: orderMap[c.id] }))
      .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
  }

  packet._objects['artifact'] = artifact.data;
  packet._objects[`artifact:${artifact_id}`] = artifact.data;
  packet.log.push(`artifact.get → ${artifact_id} (${artifact.get('artifact_type')}), ${media.length} media, ${children.length} children, ${eventRows.length} events`);

  return { data: { artifact: artifact.data, media, relations, children, events: eventRows } };
}

async function listEvents(ctx, payload, packet) {
  const { artifact_id } = payload;
  if (!artifact_id) throw new Error('artifact_id is required');

  const { data, error } = await Artifact.db
    .from('artifact_events')
    .select('*')
    .eq('artifact_id', artifact_id)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message || 'Failed to load artifact events');

  packet.log.push(`artifact.events.list → ${artifact_id} (${data.length} events)`);
  return { data: { events: data || [] } };
}

async function list(ctx, payload, packet) {
  const { artifact_type, status, tag_keys, limit = 50 } = payload;

  const artifacts = await Artifact.query({ artifact_type, status, tag_keys, limit }, ctx);

  packet.log.push(`artifact.list → ${artifacts.length} results`);
  return { data: { artifacts } };
}

async function update(ctx, payload, packet) {
  const { artifact_id, ...fields } = payload;
  if (!artifact_id) throw new Error('artifact_id is required');
  await assertOwnerOrAdmin(ctx, artifact_id, { label: 'artifact' });

  const allowed = ['artifact_type', 'title', 'body', 'summary', 'status', 'tag_keys', 'metadata', 'context', 'published_at'];
  const updates = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) throw new Error('No updatable fields provided');

  // metadata/context are JSONB columns written as a plain column overwrite
  // (Packet.save() writes dirty fields as-is, no jsonb_set/||) — shallow-merge
  // the caller's partial update onto the current value so setting one key
  // doesn't silently wipe every other key already stored there. Same fix as
  // ArkActions.update, needed here too since template metadata (used by the
  // template composer) gets edited incrementally, one field at a time.
  if (updates.metadata || updates.context) {
    const { data: current } = await Artifact.db
      .from('artifacts').select('artifact_type, metadata, context').eq('id', artifact_id).single();
    if (updates.metadata) updates.metadata = { ...(current?.metadata || {}), ...updates.metadata };
    if (updates.context)  updates.context  = { ...(current?.context  || {}), ...updates.context };

    // Validate the FINAL merged metadata, not just the partial patch — a
    // caller updating only { price } still needs the resulting whole
    // object (price + whatever fulfillment/pieces already existed) to be
    // shape-valid, same reasoning as the merge itself just above.
    const effectiveType = updates.artifact_type || current?.artifact_type;
    if (effectiveType === 'item' && updates.metadata) {
      updates.metadata = normalizeItemMetadata(updates.metadata);
    }
  }

  const artifact = new Artifact({ id: artifact_id }, { context: ctx });
  artifact.assign(updates);
  await artifact.save();

  packet._objects['artifact'] = artifact.data;
  packet._objects[`artifact:${artifact_id}`] = artifact.data;
  packet.log.push(`artifact.update → ${artifact_id}`);

  await _recordEvent(ctx, {
    artifact_id,
    event_type: 'artifact.updated',
    event_name: 'Artifact updated',
    payload: { fields: Object.keys(updates), values: updates },
  });

  return { data: { artifact: artifact.data } };
}

async function archive(ctx, payload, packet) {
  const { artifact_id } = payload;
  if (!artifact_id) throw new Error('artifact_id is required');
  await assertOwnerOrAdmin(ctx, artifact_id, { label: 'artifact' });

  const artifact = new Artifact({ id: artifact_id }, { context: ctx });
  await artifact.archive();

  // Archive is a soft-delete from the visible graph, not a hard delete — we
  // also sever any remaining parent membership for the inactive item so it
  // doesn't keep surfacing in Ephemera or parent Ark lists after a refresh.
  await ArtifactRelation.deleteWhere({ target_id: artifact_id });

  packet.log.push(`artifact.archive → ${artifact_id}`);
  return { data: { artifact: artifact.data } };
}

// ── Media ──────────────────────────────────────────────────────────────────────

// Raised from 2MB — a 300 DPI source for a 17x22 print (5100x6600px) is
// routinely several MB as a JPEG; scaling/compressing to fit a small cap
// would directly undermine the print-readiness check (printReadiness.ts).
// Room to grow, not to shrink.
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

// ── artifact.probe_media — reads pixel dimensions from a data_url without
// persisting anything. Exists because browsers can't decode HEIC at all —
// new Image() silently never fires onload for an iPhone photo, so the
// print-readiness check in ArtifactEditor (the whole reason for reading
// dimensions client-side) would just never show up for the one format it
// matters most for. image-size reads container headers directly (HEIC
// included) without a full pixel decode, so this is cheap even though it's
// a network round trip.
async function probeMedia(ctx, payload, packet) {
  const { data_url } = payload;
  if (!data_url) throw new Error('data_url is required');

  const buffer = Buffer.from(data_url.slice(data_url.indexOf(',') + 1), 'base64');
  const { width, height } = imageSize(buffer);

  packet.log.push(`artifact.probe_media → ${width}x${height}`);
  return { data: { width, height } };
}

async function addMedia(ctx, payload, packet) {
  const {
    artifact_id, media_type, provider,
    title, caption, alt, file_size,
    duration_seconds, thumbnail_url, metadata = {},
    resize_max_dimension, skip_dedup_check,
  } = payload;
  let { url, data_url, mime_type: mimeType, width, height } = payload;
  if (!artifact_id || !media_type) throw new Error('artifact_id and media_type are required');
  if (!url && !data_url)           throw new Error('url or data_url is required');
  // Owner/admin always allowed; ALSO a caretaker (unconditionally, just by
  // holding that relation) or a steward explicitly granted 'contribute' —
  // see _authz.js's header comment for why these two differ.
  await assertOwnerAdminOrDelegate(ctx, artifact_id, 'contribute', { label: 'artifact' });

  let contentHash = null;

  if (data_url) {
    // Fingerprint the ORIGINAL bytes as uploaded, before any transcode or
    // resize — the whole point is to catch "this exact file already
    // entered the system" regardless of what processing it goes through
    // afterward. Store-scoped (joined through artifacts, since
    // artifact_media has no store_id of its own): the same photo re-added
    // (e.g. after a silent failure that made a retry look necessary, or
    // just picked twice by mistake) gets rejected with a pointer to the
    // artifact that already has it, rather than silently duplicating.
    //
    // skip_dedup_check exists for deliberate internal reuse — e.g.
    // EditArkDialog's "Choose from Ark" copies an existing member's own
    // data_url onto the Ark as its splash on purpose; that's intentional
    // reuse of a photo that's already validly stored elsewhere, not a
    // second accidental upload of it, and shouldn't be rejected as one.
    contentHash = crypto.createHash('sha256')
      .update(Buffer.from(data_url.slice(data_url.indexOf(',') + 1), 'base64'))
      .digest('hex');

    const { data: existing } = skip_dedup_check ? { data: null } : await Artifact.db
      .from('artifact_media')
      .select('id, artifact_id, url, data_url, thumbnail_url, mime_type, width, height, artifacts!inner(id, title, store_id, context)')
      .eq('content_hash', contentHash)
      .eq('artifacts.store_id', ctx.store_id)
      .limit(1)
      .maybeSingle();

    if (existing) {
      // Public artifacts are catalog/gallery content — the same photo
      // legitimately living on more than one public artifact (e.g. it's
      // featured in two galleries) isn't a mistake worth blocking on the
      // way a private duplicate is. Instead of rejecting, attach the
      // ALREADY-PROCESSED bytes from the original (skipping transcode/
      // resize/size-check entirely, since that work is already done) and
      // record which media it's a duplicate of.
      if (existing.artifacts.context?.visibility === 'public') {
        const sort_order = await ArtifactMedia.nextSortOrder(artifact_id);
        const m = new ArtifactMedia({
          artifact_id,
          media_type,
          provider: provider || null,
          url: existing.url,
          data_url: existing.data_url,
          thumbnail_url: existing.thumbnail_url || thumbnail_url || null,
          title: title || null,
          caption: caption || null,
          alt: alt || null,
          mime_type: existing.mime_type,
          file_size: file_size || null,
          width: existing.width,
          height: existing.height,
          duration_seconds: duration_seconds || null,
          sort_order,
          content_hash: contentHash,
          metadata: { ...metadata, duplicate_of_artifact_id: existing.artifact_id, duplicate_of_media_id: existing.id },
        }, { context: ctx });

        await m.save();

        packet._objects[`media:${m.id}`] = m.data;
        packet.log.push(`artifact.add_media → ${media_type} → artifact:${artifact_id} (linked to public duplicate media:${existing.id})`);

        return { data: { media: m.data, linked_to: existing.artifact_id } };
      }

      throw Object.assign(
        new Error(`This exact photo has already been added, on "${existing.artifacts.title}" (${existing.artifact_id}).`),
        { status: 409, code: 'DUPLICATE_MEDIA', existing_artifact_id: existing.artifact_id, existing_media_id: existing.id },
      );
    }

    // HEIC/HEIF (iPhone's default capture format) can't render as an <img>
    // in almost any browser — transcode to JPEG before it's ever stored, so
    // nothing downstream (Grid, catalog publish, etc.) has to know this
    // happened.
    const wasHeic = /^data:image\/hei[cf]/i.test(data_url);
    data_url = await maybeTranscodeHeic(data_url);
    if (wasHeic) mimeType = 'image/jpeg';

    // Storage is always web resolution — actual printing is an offline
    // process from a separate full-res source file, never this stored
    // copy, so there's no reason to keep a large original around here.
    if (resize_max_dimension) {
      data_url = await resizeDataUrl(data_url, { maxDimension: resize_max_dimension });
      mimeType = 'image/jpeg';
      // Whatever width/height the client probed described the pre-resize
      // original — stale and wrong for what's actually being stored now.
      const resized = imageSize(Buffer.from(data_url.slice(data_url.indexOf(',') + 1), 'base64'));
      width = resized.width;
      height = resized.height;
    }

    const rawBytes = Math.round((data_url.length - (data_url.indexOf(',') + 1)) * 0.75);
    if (rawBytes > MAX_BLOB_BYTES) throw new Error(`Blob too large (${(rawBytes / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_BLOB_BYTES / 1024 / 1024} MB.`);

    // Real storage instead of inlining the blob into the row — a page with
    // a few dozen photos was measured at ~58MB of embedded base64 before
    // this (see .claude/plans/ark/ui_resolution_contracts.md work). Content
    // is uploaded under its own contentHash, so identical bytes reused
    // across artifacts collapse to one storage object.
    const storage = getManifest().get('storage');
    url = await uploadImageBytes(storage, { data_url, mime_type: mimeType, content_hash: contentHash });
    data_url = null;
  }

  const sort_order = await ArtifactMedia.nextSortOrder(artifact_id);

  const m = new ArtifactMedia({
    artifact_id,
    media_type,
    provider:         provider         || null,
    url:              url              || null,
    data_url:         data_url         || null,
    thumbnail_url:    thumbnail_url    || null,
    title:            title            || null,
    caption:          caption          || null,
    alt:              alt              || null,
    mime_type:        mimeType         || null,
    file_size:        file_size        || null,
    width:            width            || null,
    height:           height           || null,
    duration_seconds: duration_seconds || null,
    sort_order,
    content_hash: contentHash,
    metadata,
  }, { context: ctx });

  await m.save();

  packet._objects[`media:${m.id}`] = m.data;
  packet.log.push(`artifact.add_media → ${media_type} → artifact:${artifact_id}`);

  await _recordEvent(ctx, {
    artifact_id,
    event_type: 'media.added',
    event_name: 'Media added',
    payload: { media_type, media_id: m.id, title: title || null, mime_type: mimeType || null },
  });

  return { data: { media: m.data } };
}

async function removeMedia(ctx, payload, packet) {
  const { media_id } = payload;
  if (!media_id) throw new Error('media_id is required');

  // Verify ownership via the artifact join (no store_id on artifact_media itself)
  const row = await ArtifactMedia.findWithOwner(media_id);
  if (!row || row.artifacts?.store_id !== ctx.store_id) {
    throw Object.assign(new Error('Media not found'), { status: 404 });
  }
  await assertOwnerOrAdmin(ctx, row.artifact_id, { label: 'artifact' });

  const m = new ArtifactMedia({ id: media_id }, { context: ctx });
  await m.delete();

  await _recordEvent(ctx, {
    artifact_id: row.artifact_id,
    event_type: 'media.removed',
    event_name: 'Media removed',
    payload: { media_id, media_type: row.media_type || null },
  });

  packet.log.push(`artifact.remove_media → ${media_id}`);
  return { data: { ok: true } };
}

// ── Likes — event-sourced, no dedicated table/counter column ───────────────────
// artifact_events already exists for this (artifact.created/media.added/etc via
// _recordEvent above) — likes are just two more event_types on the same table,
// per Matt's own direction. No assertOwnerOrAdmin here: unlike every other
// mutation in this file, liking is deliberately available to ANY visitor
// (including GUEST — see TraceActions.js's artifact.like capability) against
// ANY artifact they can see, not just their own.

const LIKE_EVENT_TYPES = ['artifact.liked', 'artifact.unliked'];

async function _getLikeCount(artifact_id) {
  const { data } = await Artifact.db
    .from('artifact_events')
    .select('event_type')
    .eq('artifact_id', artifact_id)
    .in('event_type', LIKE_EVENT_TYPES);
  return (data || []).reduce((n, e) => n + (e.event_type === 'artifact.liked' ? 1 : -1), 0);
}

async function toggleLike(ctx, payload, packet) {
  const { artifact_id, client_id, liked } = payload;
  if (!artifact_id || !client_id) throw new Error('artifact_id and client_id are required');

  // Deliberately NOT Artifact.findById's strict per-artifact visibility gate
  // — a gallery member can individually be context.visibility:'private'
  // while still being a displayed tile in a PUBLIC Ark (ark.get's own
  // member list is Ark-level-gated only, no per-member visibility recheck;
  // see its header comment). A visitor who can already see this tile as a
  // gallery card must be able to like it — re-applying findById's stricter
  // check here would silently 404 exactly the tiles this feature exists
  // for. Still a real existence/store/inactive check, so a nonexistent or
  // cross-store id can't be probed.
  const { data: row } = await Artifact.db
    .from('artifacts')
    .select('id, inactive, store_id')
    .eq('id', artifact_id)
    .maybeSingle();
  if (!row || row.inactive === true || (ctx.store_id && row.store_id !== ctx.store_id)) {
    throw Object.assign(new Error('Artifact not found'), { status: 404 });
  }

  // Idempotent per (artifact_id, client_id): only record an actual state
  // transition. Without this, a double-click (or a naive request replay)
  // would just keep inserting more artifact.liked rows and inflate the
  // count — the whole point of a count is that it means something.
  const { data: last } = await Artifact.db
    .from('artifact_events')
    .select('event_type')
    .eq('artifact_id', artifact_id)
    .eq('payload->>client_id', client_id)
    .in('event_type', LIKE_EVENT_TYPES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const alreadyLiked = last?.event_type === 'artifact.liked';
  if (!!liked !== alreadyLiked) {
    await _recordEvent(ctx, {
      artifact_id,
      event_type: liked ? 'artifact.liked' : 'artifact.unliked',
      event_name: liked ? 'Artifact liked' : 'Artifact unliked',
      payload: { client_id },
    });
  }

  const like_count = await _getLikeCount(artifact_id);
  packet.log.push(`artifact.like → ${artifact_id} (${liked ? 'liked' : 'unliked'}) → ${like_count}`);
  return { data: { artifact_id, liked: !!liked, like_count } };
}

// ── Relations ──────────────────────────────────────────────────────────────────

async function relate(ctx, payload, packet) {
  const { source_id, target_id, relation_type, order_index, metadata = {} } = payload;
  if (!source_id || !target_id || !relation_type) throw new Error('source_id, target_id, and relation_type are required');
  await assertOwnerOrAdmin(ctx, source_id, { label: 'artifact' });

  // Cheap invariant worth enforcing at creation rather than discovering bad
  // data later — a caretaker/steward relation only means anything if its
  // target actually resolves to a real user (see _authz.js's
  // assertOwnerAdminOrDelegate, which looks up the caller's OWN user
  // artifact the same way).
  if (relation_type === RELATION_TYPES.CARETAKER || relation_type === RELATION_TYPES.STEWARD) {
    const target = await Artifact.findById(target_id, ctx);
    if (!target || target.get('artifact_type') !== 'user') {
      throw new Error(`artifact.relate: a "${relation_type}" relation's target must be a 'user' artifact`);
    }
  }

  const rel = new ArtifactRelation({
    source_artifact_id: source_id,
    target_artifact_id: target_id,
    relation_type,
    order_index: order_index ?? null,
    metadata,
  }, { context: ctx });

  await rel.save();

  packet._objects['relation'] = rel.data;
  packet.log.push(`artifact.relate → ${source_id} —[${relation_type}]→ ${target_id}`);

  return { data: { relation: rel.data } };
}

async function unrelate(ctx, payload, packet) {
  const { source_id, target_id, relation_type } = payload;
  if (!source_id || !target_id || !relation_type) throw new Error('source_id, target_id, and relation_type are required');
  await assertOwnerOrAdmin(ctx, source_id, { label: 'artifact' });

  await ArtifactRelation.deleteWhere({ source_id, target_id, relation_type });

  packet.log.push(`artifact.unrelate → ${source_id} —[${relation_type}]→ ${target_id}`);
  return { data: { ok: true } };
}

// ── URL / OG resolver ──────────────────────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g,      '&')
    .replace(/&quot;/g,     '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g,       '<')
    .replace(/&gt;/g,       '>');
}

function extractOgMeta(html, fallbackUrl) {
  const meta = {};
  const metaRe = /<meta\s+([^>]+?)(?:\s*\/)?>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    const keyM  = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const valM  = attrs.match(/content\s*=\s*["']([^"']*?)["']/i);
    if (keyM && valM) meta[keyM[1].toLowerCase()] = decodeEntities(valM[1]);
  }
  const titleM    = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const pageTitle = titleM ? decodeEntities(titleM[1].trim()) : null;
  let hostname = fallbackUrl;
  try { hostname = new URL(fallbackUrl).hostname.replace(/^www\./, ''); } catch {}
  return {
    url:         meta['og:url']                                         || fallbackUrl,
    title:       meta['og:title']       || meta['twitter:title']       || pageTitle || null,
    description: meta['og:description'] || meta['twitter:description'] || meta['description'] || null,
    image:       meta['og:image']       || meta['twitter:image']       || null,
    site_name:   meta['og:site_name']                                  || hostname,
  };
}

async function resolveUrl(ctx, payload, packet) {
  const { url, media_id } = payload;
  if (!url) throw new Error('url is required');

  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS supported');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      const og = { url, title: null, description: null, image: null, site_name: parsed.hostname.replace(/^www\./, '') };
      packet.log.push(`artifact.resolve_url → ${url} (non-HTML: ${contentType})`);
      return { data: { og } };
    }

    const decoder = new TextDecoder();
    const reader  = res.body?.getReader();
    let html = '';
    const MAX = 100 * 1024;
    if (reader) {
      while (html.length < MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (html.includes('</head>') || html.includes('<body')) break;
      }
      reader.cancel().catch(() => {});
    }

    const og = extractOgMeta(html, url);
    packet.log.push(`artifact.resolve_url → ${url} → "${og.title || '(no title)'}"`);

    if (media_id) {
      const m = new ArtifactMedia({ id: media_id, metadata: { og } }, { context: ctx });
      m.dirty.add('metadata');
      await m.save();
    }

    return { data: { og } };

  } catch (err) {
    if (err.name === 'AbortError') throw new Error('URL fetch timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  create,
  get,
  list,
  listEvents,
  update,
  archive,
  addMedia,
  removeMedia,
  toggleLike,
  _getLikeCount,
  relate,
  unrelate,
  resolveUrl,
  probeMedia,
  _recordEvent,
};
