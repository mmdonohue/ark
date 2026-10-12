'use strict';

// _authz — per-resource ownership enforcement, layered UNDER the existing
// capability system (TraceActions.js's _defaultCapabilities), not instead
// of it. Capabilities answer "can this role/rank hold artifact.write AT
// ALL" — that check alone grants it to any authenticated role (USER/TECH/
// PARTNER/ADMIN), rank-gated only for the handful of capabilities listed
// in RANK_REQUIRED (sync.write, catalog.write, etc.). artifact.write was
// never one of them, meaning ANY logged-in customer could call
// ark.update/ark.archive/artifact.update/etc. against ANY artifact,
// including ones they don't own — confirmed live: a real rank-10 USER
// account successfully overwrote another Ark's title via dispatch().
//
// This closes that gap: the site ADMIN (rank >= 100) may still modify
// anything, same as always; anyone else may only modify a resource whose
// owner_id/created_by matches their own user_id. Deliberately re-fetches
// the row fresh rather than trusting anything in the caller's payload —
// a forged/stale owner_id in the request body can't matter if the check
// never looks at the payload for it.
//
// A resource with no owner_id/created_by at all (shouldn't happen today —
// every artifact.create backfills one — but if it ever did) falls through
// to the 403 for anyone below rank 100, the same safe default as an
// explicit ownership mismatch. Never treated as "unclaimed, anyone may
// take it."

const Artifact = require('../domain/Artifact');

// Caretaker/Steward — the two ownership-adjacent relations layered ON TOP
// of assertOwnerOrAdmin below, not a replacement for it. Both are plain
// artifact_relations rows (artifact --[caretaker/steward]--> a 'user'
// artifact, matched back to a real Seravanna user via
// metadata.seravanna_user_id — see ark/scripts/seed-users.js), created by
// the owner/admin via the existing artifact.relate action (already
// correctly restricted to the artifact's own owner/admin, nothing new
// needed on that side).
//
// The two differ in origin, not just degree:
//   Caretaker — arises from a transaction (e.g. adopting a sculpture). A
//     fixed, narrow, UNCONDITIONAL grant: existing at all is enough to
//     contribute (add a photo), never anything else.
//   Steward   — arises from explicit delegation BY the owner. Grants only
//     whatever capability string the owner wrote into the relation's own
//     metadata.capabilities at grant time — nothing assumed.
const RELATION_TYPES = { CARETAKER: 'caretaker', STEWARD: 'steward' };

async function _findUserArtifactId(userId) {
  if (userId == null) return null;
  const { data } = await Artifact.db
    .from('artifacts')
    .select('id')
    .eq('artifact_type', 'user')
    .filter('metadata->>seravanna_user_id', 'eq', String(userId))
    .maybeSingle();
  return data?.id || null;
}

async function _findRelation(artifact_id, userArtifactId, relationType) {
  const { data } = await Artifact.db
    .from('artifact_relations')
    .select('metadata')
    .eq('source_artifact_id', artifact_id)
    .eq('target_artifact_id', userArtifactId)
    .eq('relation_type', relationType)
    .maybeSingle();
  return data || null;
}

// Same owner/admin fallthrough as assertOwnerOrAdmin, but before failing,
// also checks whether ctx.user_id holds a caretaker/steward relation to
// this artifact granting `capability`. This pass only ever passes
// 'contribute' (see ArtifactActions.addMedia) — no other capability string
// is consumed anywhere yet.
async function assertOwnerAdminOrDelegate(ctx, artifact_id, capability, { label = 'artifact' } = {}) {
  if (!artifact_id) return;
  if ((ctx.rank || 0) >= 100) return;

  const { data: row } = await Artifact.db
    .from('artifacts').select('owner_id, created_by').eq('id', artifact_id).maybeSingle();
  if (!row) return;
  const ownerId = row.owner_id ?? row.created_by;
  if (ownerId != null && ctx.user_id != null && ownerId === ctx.user_id) return;

  const userArtifactId = await _findUserArtifactId(ctx.user_id);
  if (userArtifactId) {
    const caretaker = await _findRelation(artifact_id, userArtifactId, RELATION_TYPES.CARETAKER);
    if (caretaker) return; // fixed, narrow grant — existence alone is enough

    const steward = await _findRelation(artifact_id, userArtifactId, RELATION_TYPES.STEWARD);
    if (steward?.metadata?.capabilities?.includes(capability)) return;
  }

  throw Object.assign(
    new Error(`Not authorized to modify this ${label}`),
    { status: 403, code: 'NOT_AUTHORIZED' },
  );
}

async function assertOwnerOrAdmin(ctx, artifact_id, { label = 'artifact' } = {}) {
  if (!artifact_id) return; // nothing to check yet — caller's own required-field validation runs first
  if ((ctx.rank || 0) >= 100) return; // site admin/owner — always allowed

  const { data: row } = await Artifact.db
    .from('artifacts')
    .select('owner_id, created_by')
    .eq('id', artifact_id)
    .maybeSingle();

  if (!row) return; // let the caller's own not-found handling take it from here

  const ownerId = row.owner_id ?? row.created_by;
  if (ownerId != null && ctx.user_id != null && ownerId === ctx.user_id) return; // real owner

  throw Object.assign(
    new Error(`Not authorized to modify this ${label} — owner only`),
    { status: 403, code: 'NOT_OWNER' },
  );
}

module.exports = { assertOwnerOrAdmin, assertOwnerAdminOrDelegate, RELATION_TYPES, _findUserArtifactId };
