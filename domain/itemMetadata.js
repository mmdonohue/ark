'use strict';

// itemMetadata.js — the metadata shape for artifact_type: 'item' (physical,
// sellable pieces — e.g. Sculpture's "Totem Pair"). Not a governed contract
// like a template's fields[] (no template targets entry_artifact_type:
// 'item' today) — just a validated, normalized shape enforced at
// ArtifactActions.create/update, the same light touch this codebase already
// gives 'photo' uploads (HEIC transcode) without a full type-registry
// system built for it.
//
// Deliberately advisory, not a governed commercial ledger: price/fulfillment
// here are what the seller intends. "The catalog" is a Catalog-templated
// Ark whose members are item artifacts (see CatalogActions.js's header
// comment) — this file only validates what lives ON one item, never
// anything about whether/where it's published.

const SHIPPING_METHODS      = ['parcel', 'oversized', 'freight', 'local_delivery', 'pickup'];
const SHIPPING_PRICE_MODES  = ['fixed', 'calculated', 'quote'];
const AVAILABILITY_STATES   = ['in_stock', 'reserved', 'sold', 'made_to_order'];
const WEIGHT_UNITS          = ['lb', 'kg'];
const DIMENSION_UNITS       = ['in', 'cm'];

function normalizePrice(price) {
  if (price == null) return price;
  if (typeof price.amount !== 'number' || !Number.isInteger(price.amount) || price.amount < 0) {
    throw new Error('item.price.amount must be a non-negative integer (minor units, e.g. cents) — same convention Stripe payment intents already use in this codebase');
  }
  return { amount: price.amount, currency: (price.currency || 'usd').toLowerCase() };
}

const CURRENT_YEAR = new Date().getFullYear();

function normalizeMaterials(materials) {
  if (materials == null) return materials;
  if (typeof materials !== 'string' || !materials.trim()) {
    throw new Error('item.materials must be a non-empty string (e.g. "Bronze, oak base")');
  }
  return materials.trim();
}

function normalizeYear(year) {
  if (year == null) return year;
  if (!Number.isInteger(year) || year < 1000 || year > CURRENT_YEAR + 1) {
    throw new Error(`item.year must be a 4-digit integer, at most ${CURRENT_YEAR + 1}`);
  }
  return year;
}

function normalizeAvailability(availability) {
  if (availability == null) return availability;
  if (!AVAILABILITY_STATES.includes(availability)) {
    throw new Error(`item.availability must be one of: ${AVAILABILITY_STATES.join(', ')}`);
  }
  return availability;
}

function normalizeFulfillment(fulfillment) {
  if (fulfillment == null) return fulfillment;
  const out = {};

  if (fulfillment.shipping_method != null) {
    // An array, not a single pick — an oversized piece plausibly supports
    // more than one method at once (e.g. local_delivery OR pickup, never
    // parcel).
    const methods = Array.isArray(fulfillment.shipping_method) ? fulfillment.shipping_method : [fulfillment.shipping_method];
    if (!methods.length) throw new Error('item.fulfillment.shipping_method must have at least one entry');
    for (const m of methods) {
      if (!SHIPPING_METHODS.includes(m)) {
        throw new Error(`item.fulfillment.shipping_method "${m}" must be one of: ${SHIPPING_METHODS.join(', ')}`);
      }
    }
    out.shipping_method = methods;
  }

  if (fulfillment.shipping_price != null) {
    const { mode, amount } = fulfillment.shipping_price;
    if (!SHIPPING_PRICE_MODES.includes(mode)) {
      throw new Error(`item.fulfillment.shipping_price.mode must be one of: ${SHIPPING_PRICE_MODES.join(', ')}`);
    }
    if (mode === 'fixed') {
      // "fixed" is meaningless without an actual amount to charge.
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
        throw new Error('item.fulfillment.shipping_price.amount is required (non-negative integer) when mode is "fixed"');
      }
      out.shipping_price = { mode, amount };
    } else {
      // calculated (live carrier-rate lookup) / quote (manual, offline) —
      // neither has a real implementation anywhere in this codebase yet;
      // this just records the seller's intended mode.
      out.shipping_price = { mode };
    }
  }

  return out;
}

// Lucky Totem lore — see .claude/plans/lucky_totems_ui_guide.md. Deliberately
// free text, no enum: the guide's own examples (Energy/Field/Action/Target)
// are suggestions for the UI to offer, not a closed list to enforce here —
// "allow free text" is explicit in the guide, unlike availability/shipping_
// method above which really are closed sets. Every field optional; the
// guide's stated minimum is name + energy + action + target, and even that
// isn't enforced here — a totem with none of this is just an item without
// lore yet, not invalid.
const LORE_FIELDS = ['energy', 'field', 'action', 'target', 'nemesis', 'mantra'];

function normalizeLore(lore) {
  if (lore == null) return lore;
  const out = {};
  for (const key of LORE_FIELDS) {
    if (lore[key] == null) continue;
    if (typeof lore[key] !== 'string') throw new Error(`item.lore.${key} must be a string`);
    const trimmed = lore[key].trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

// One entry per physical piece — "Totem Pair" (the only real item artifact
// today) ships as two, not one; a single flat weight/dimensions field
// breaks down for anything that isn't a single box. A single sculpture is
// simply pieces: [{...}].
function normalizePieces(pieces) {
  if (pieces == null) return pieces;
  if (!Array.isArray(pieces) || !pieces.length) {
    throw new Error('item.pieces must be a non-empty array — one entry per physical piece (e.g. a pair ships as 2)');
  }
  return pieces.map((piece, i) => {
    const out = {};
    if (piece.weight != null) {
      const { value, unit = 'lb' } = piece.weight;
      if (typeof value !== 'number' || value <= 0) throw new Error(`item.pieces[${i}].weight.value must be a positive number`);
      if (!WEIGHT_UNITS.includes(unit)) throw new Error(`item.pieces[${i}].weight.unit must be one of: ${WEIGHT_UNITS.join(', ')}`);
      out.weight = { value, unit };
    }
    if (piece.dimensions != null) {
      const { length, width, height, unit = 'in' } = piece.dimensions;
      for (const [k, v] of [['length', length], ['width', width], ['height', height]]) {
        if (typeof v !== 'number' || v <= 0) throw new Error(`item.pieces[${i}].dimensions.${k} must be a positive number`);
      }
      if (!DIMENSION_UNITS.includes(unit)) throw new Error(`item.pieces[${i}].dimensions.unit must be one of: ${DIMENSION_UNITS.join(', ')}`);
      out.dimensions = { length, width, height, unit };
    }
    return out;
  });
}

// Validates/normalizes only the item-specific keys — any other metadata key
// on the object passes through untouched, same "don't force a schema on
// the whole bag" posture every other artifact_type's freeform metadata has.
function normalizeItemMetadata(metadata = {}) {
  const out = { ...metadata };
  if ('price' in metadata)        out.price        = normalizePrice(metadata.price);
  if ('availability' in metadata) out.availability = normalizeAvailability(metadata.availability);
  if ('fulfillment' in metadata)  out.fulfillment  = normalizeFulfillment(metadata.fulfillment);
  if ('pieces' in metadata)       out.pieces       = normalizePieces(metadata.pieces);
  if ('materials' in metadata)    out.materials    = normalizeMaterials(metadata.materials);
  if ('year' in metadata)         out.year         = normalizeYear(metadata.year);
  if ('lore' in metadata)         out.lore         = normalizeLore(metadata.lore);
  return out;
}

module.exports = {
  normalizeItemMetadata,
  SHIPPING_METHODS,
  SHIPPING_PRICE_MODES,
  AVAILABILITY_STATES,
  WEIGHT_UNITS,
  DIMENSION_UNITS,
  LORE_FIELDS,
};
