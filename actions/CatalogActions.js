'use strict';

// CatalogActions — sale-code / Steward-claim logic only. A "catalog" is now
// a first-class artifact: an Ark using the 'catalog' template (see the
// seeded template row, slug 'catalog'; mirrors Gallery/Cinema exactly —
// 'contains' members, each an 'item' artifact, order_index preserves the
// curated sort). No dedicated catalog.* read/list/publish actions exist —
// ark.list/ark.get/ark.create/ark.add_artifact (all generic, already built)
// are the whole read+write surface; CatalogView.tsx is the only
// catalog-specific frontend piece, and it just renders whatever artifacts
// ark.get already returned.
//
// Two earlier designs lived here and were torn out in favor of this one:
// a separate items/store_items/categories commerce schema (stale copy of
// data the artifact already owns via itemMetadata.js), and later a single
// global metadata.in_catalog boolean + tag_keys-based bulk publish (worked,
// but "the catalog" could only ever be one undifferentiated pile of items
// with no order and no way to curate more than one).
const Artifact = require('../domain/Artifact');
const crypto = require('crypto');
const { RELATION_TYPES, _findUserArtifactId } = require('./_authz');

// 8 chars, unambiguous alphabet (no 0/O/1/I) — short enough to hand-write
// on a receipt slip and read back without transcription errors.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function _generateCode() {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

// Mirrors just enough of ark/scripts/seed-users.js's row→artifact mapping
// to make _findUserArtifactId succeed from here on — not a full profile
// mirror (that script is the real source for that, run separately). This
// only exists so a buyer who's never been seeded still gets a Steward
// relation target the first time they redeem a code, same self-heal
// posture as AccountMenu's refresh-profile fix.
async function _ensureUserArtifact(ctx) {
  const existing = await _findUserArtifactId(ctx.user_id);
  if (existing) return existing;

  const name = [ctx.user?.first_name, ctx.user?.last_name].filter(Boolean).join(' ') || 'Customer';
  const { data, error } = await Artifact.db
    .from('artifacts')
    .insert({
      artifact_type: 'user',
      title: name,
      store_id: ctx.store_id,
      owner_id: ctx.user_id,
      created_by: ctx.user_id,
      status: 'published',
      context: { visibility: 'private' },
      metadata: { seravanna_user_id: ctx.user_id, email: ctx.user?.email || null },
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to provision user artifact: ${error.message}`);
  return data.id;
}

// ── catalog.generate_sale_code — payload: { artifact_id } ──
// Admin-only (catalog.write). Idempotent: returns the existing unredeemed
// code for this piece rather than minting a second one on a double-click —
// sale_price (dollars, converted to cents) is only ever recorded on first
// generation; re-clicking Confirm Sale for an already-unredeemed code just
// returns what's already there rather than silently overwriting a real
// recorded sale price with whatever happens to be in the field this time.
async function generateSaleCode(ctx, payload, packet) {
  const { artifact_id, sale_price } = payload;
  if (!artifact_id) throw new Error('artifact_id is required');

  const { data: existing } = await Artifact.db
    .from('item_sale_codes')
    .select('code, sale_price')
    .eq('artifact_id', artifact_id)
    .is('redeemed_at', null)
    .maybeSingle();
  if (existing) {
    packet.log.push(`catalog.generate_sale_code → ${artifact_id} (existing, unredeemed)`);
    return { data: { code: existing.code, sale_price: existing.sale_price } };
  }

  const { data, error } = await Artifact.db
    .from('item_sale_codes')
    .insert({
      artifact_id,
      code: _generateCode(),
      created_by: ctx.user_id,
      sale_price: sale_price != null ? Math.round(Number(sale_price) * 100) : null,
    })
    .select('code, sale_price')
    .single();
  if (error) throw new Error(error.message);

  packet.log.push(`catalog.generate_sale_code → ${artifact_id}`);
  return { data: { code: data.code, sale_price: data.sale_price } };
}

// ── catalog.redeem_sale_code — payload: { code } ──
// Any logged-in user (catalog.redeem; GUEST-excluded — see TraceActions.js)
// — never a guest, since this attributes the claim to ctx.user_id. The
// buyer only ever needs the code itself; the artifact it resolves to is
// looked up from the code row, not supplied by the caller.
async function redeemSaleCode(ctx, payload, packet) {
  const { code } = payload;
  if (!code) throw new Error('code is required');

  const { data: row, error } = await Artifact.db
    .from('item_sale_codes')
    .select('id, artifact_id, redeemed_at')
    .eq('code', code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw Object.assign(new Error('Invalid code'), { status: 404 });
  if (row.redeemed_at) throw Object.assign(new Error('This code has already been claimed'), { status: 409 });

  const userArtifactId = await _ensureUserArtifact(ctx);

  const artifact = await Artifact.findById(row.artifact_id, { ...ctx, rank: 100 }); // bypass visibility gate — the code itself is the authorization
  if (!artifact) throw Object.assign(new Error('That piece could not be found'), { status: 404 });
  // Steward, not Caretaker — a sale is an explicit stewardship transfer,
  // not the unconditional/automatic grant Caretaker models. Steward's
  // capabilities are opt-in per _authz.js (nothing assumed), so this
  // explicitly grants 'contribute' — the only capability string anything
  // (ArtifactActions.addMedia) actually checks for today.
  await artifact.relate(userArtifactId, RELATION_TYPES.STEWARD, { capabilities: ['contribute'] });

  await Artifact.db
    .from('item_sale_codes')
    .update({ redeemed_at: new Date().toISOString(), redeemed_by_user_id: ctx.user_id })
    .eq('id', row.id);

  packet.log.push(`catalog.redeem_sale_code → ${row.artifact_id} claimed by user:${ctx.user_id}`);
  return { data: { artifact_id: row.artifact_id, title: artifact.get('title') } };
}

module.exports = { generateSaleCode, redeemSaleCode };
