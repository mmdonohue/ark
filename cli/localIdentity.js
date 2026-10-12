'use strict';

// Local identity auto-provisioning — lets ARK be used with no cloud account
// at all (a hiker running entirely off a USB drive). On first run for a
// given local vessel, provisions:
//   - role artifacts (owner/operator/guest)
//   - one vessel-identity artifact (artifact_type: persona — 'hiker', 'store', ...)
//   - one ark_actor, role = owner
// and reuses them on every run after. "Preloaded" thumb-drive ARKs are just
// this run once ahead of time with --persona set to the intended product.
//
// Deliberately bypasses dispatch()/capability gating — bootstrapping the
// first local identity can't itself be authorized by a governed action,
// since nothing exists yet to grant that authorization. Same exception as
// the cloud seed (migrations/028_ark_actors_seed.sql), scoped locally.
// Every actor/artifact created after this one goes through the normal
// governed actions (ark_actor.create, artifact.create).

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const Artifact = require('../domain/Artifact');
const ArkActor = require('../domain/ArkActor');
const { registerRecipes } = require('../core/PipelineRegistry');

const PERSONAS_PATH = path.resolve(__dirname, '../pipelines/personas.yaml');

function _personasDoc() {
  if (!fs.existsSync(PERSONAS_PATH)) return { personas: {} };
  return yaml.load(fs.readFileSync(PERSONAS_PATH, 'utf8')) || { personas: {} };
}

function _recipesForPersona(persona) {
  return _personasDoc().personas?.[persona] || [];
}

// The vessel-identity artifact's artifact_type IS the persona name (§41.5) —
// there's no separate "vessel" table/type to query by. To find it without
// already knowing the persona (the reuse path), check every known persona
// name from personas.yaml.
async function _findVesselArtifact(ctx) {
  const personaNames = Object.keys(_personasDoc().personas || {});
  for (const type of personaNames) {
    const [found] = await Artifact.query({ artifact_type: type }, ctx);
    if (found) return found;
  }
  return null;
}

const LOCAL_ROLES = [
  { slug: 'owner',    rank: 100 },
  { slug: 'operator', rank: 50 },
  { slug: 'guest',    rank: 10 },
];

async function _findOrCreateRoleArtifacts(ctx) {
  const roles = {};
  for (const { slug, rank } of LOCAL_ROLES) {
    const existing = await Artifact.query(
      { artifact_type: 'role', filters: [['slug', 'eq', slug]] },
      ctx,
    );
    if (existing.length) {
      roles[slug] = existing[0];
      continue;
    }
    const artifact = new Artifact({
      artifact_type: 'role',
      title:         slug,
      slug,
      status:        'published',
      metadata:      { rank },
      context:       { visibility: 'private' },
    }, { context: ctx });
    await artifact.save();
    roles[slug] = artifact.data;
  }
  return roles;
}

async function _findOrCreateVesselArtifact(ctx, persona) {
  const existing = await Artifact.query({ artifact_type: persona }, ctx);
  if (existing.length) return existing[0];

  const artifact = new Artifact({
    artifact_type: persona,
    title:         `Local ${persona} vessel`,
    slug:          `local-${persona}-vessel`,
    status:        'published',
    metadata:      {},
    context:       { visibility: 'private' },
  }, { context: ctx });
  await artifact.save();
  return artifact.data;
}

async function ensureLocalIdentity({ store_id = 1, persona = 'hiker', name } = {}) {
  // 'bootstrap' is a sentinel, not a real actor id — it only needs to be
  // truthy to satisfy authorize()'s actor check while creating the very
  // first identity records on this vessel (the same first-admin problem
  // the cloud seed has: nothing can authorize creating the first identity,
  // because nothing exists yet to grant that authorization). Never persisted
  // as a foreign key anywhere — the real actor gets its own generated id.
  const ctx = { store_id, ark_actor_id: 'bootstrap', source: 'cli-bootstrap' };

  const { data: existingActor } = await ArkActor.db
    .from('ark_actors')
    .select('*')
    .eq('store_id', store_id)
    .limit(1)
    .maybeSingle();

  if (existingActor) {
    const roleArtifact = existingActor.role_id ? await Artifact.findById(existingActor.role_id, ctx) : null;
    const vessel = await _findVesselArtifact(ctx);
    return {
      ark_actor_id: existingActor.id,
      display_name: existingActor.display_name,
      role:         roleArtifact?.get('slug') || 'owner',
      rank:         roleArtifact?.get('metadata')?.rank ?? 100,
      vessel:       vessel ? { artifact_type: vessel.artifact_type, title: vessel.title } : null,
      isFirstRun:   false,
    };
  }

  // First run for this vessel — provision everything.
  const roles = await _findOrCreateRoleArtifacts(ctx);
  const vessel = await _findOrCreateVesselArtifact(ctx, persona);

  const actor = new ArkActor({
    display_name: name || 'friend',
    email:         null,
    role_id:       roles.owner.id,
  }, { context: ctx });
  await actor.save();

  // "Preloaded" == the persona's recipe bundle gets registered right here,
  // once, at first provisioning — not on every boot.
  const recipes = _recipesForPersona(persona);
  if (recipes.length) {
    await registerRecipes(recipes, ctx);
  }

  return {
    ark_actor_id: actor.id,
    display_name: actor.get('display_name'),
    role:         'owner',
    rank:         100,
    vessel:       { artifact_type: vessel.artifact_type, title: vessel.title },
    isFirstRun:   true,
  };
}

module.exports = { ensureLocalIdentity };
