'use strict';

const ArkActor = require('../domain/ArkActor');
const Artifact = require('../domain/Artifact');

// ark_actor.create — creates an actor and links it to a role artifact
// (artifact_type: 'role') by slug. Rank-gated to owner-only (see
// TraceActions.RANK_REQUIRED) — creating a new identity on a vessel is
// consequential, same tier as sync.push.
async function create(ctx, payload, packet) {
  const { display_name, email, role_slug } = payload;
  if (!display_name) throw new Error('display_name is required');

  let role_id = null;
  if (role_slug) {
    const roles = await Artifact.query(
      { artifact_type: 'role', filters: [['slug', 'eq', role_slug]] },
      ctx,
    );
    if (!roles.length) throw new Error(`Unknown role: ${role_slug}`);
    role_id = roles[0].id;
  }

  const actor = new ArkActor({
    display_name,
    email: email || null,
    role_id,
  }, { context: ctx });

  await actor.save();

  packet._objects['ark_actor'] = actor.data;
  packet.log.push(`ark_actor.create → ${actor.id} "${display_name}"${role_slug ? ` [${role_slug}]` : ''}`);

  return { data: { ark_actor: actor.data } };
}

module.exports = { create };
