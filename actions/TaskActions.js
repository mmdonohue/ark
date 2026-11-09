'use strict';

// TaskActions — creating task intent without authorizing it.
//
// task.propose writes an artifact_type 'task' whose state is always
// 'proposed', whatever the caller asks for. A proposal can't run:
// harness.run refuses it until someone with authority changes its state to
// 'ready' (artifact.update). That keeps "an agent suggested this work" and
// "this work was approved" as two distinct, separately ledgered acts.

const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');

const LIST_FIELDS = ['required_capabilities', 'acceptance_criteria'];

// payload: { title, description?, required_capabilities?, acceptance_criteria?, inputs?, derived_from? }
async function propose(ctx, payload, packet) {
  const { title, description = '', inputs = {}, derived_from = null } = payload;
  if (!title || !String(title).trim()) throw Object.assign(new Error('title is required'), { status: 400 });
  for (const f of LIST_FIELDS) {
    if (payload[f] != null && !Array.isArray(payload[f])) throw Object.assign(new Error(`${f} must be an array`), { status: 400 });
  }

  if (derived_from) {
    const source = await Artifact.findById(derived_from, ctx);
    if (!source) throw Object.assign(new Error('derived_from artifact not found'), { status: 404 });
  }

  const task = new Artifact({
    artifact_type: 'task',
    title: String(title).trim().slice(0, 200),
    body: String(description),
    summary: String(description).split('\n')[0].slice(0, 280),
    context: {
      visibility: 'private',
      state: 'proposed',
      inputs,
      required_capabilities: payload.required_capabilities || [],
      acceptance_criteria: payload.acceptance_criteria || [],
      // Who proposed it: the actor, and the agent run when it was delegated.
      proposed_by: {
        actor: ctx.user_id || ctx.ark_actor_id || null,
        delegation: ctx.delegation || null,
      },
      derived_from,
    },
  }, { context: ctx });
  await task.save();

  if (derived_from) {
    await new ArtifactRelation({
      source_artifact_id: task.id,
      target_artifact_id: derived_from,
      relation_type: 'derived_from',
    }, { context: ctx }).save();
  }

  packet._objects['task'] = task.data;
  packet.log.push(`task.propose → ${task.id} "${task.get('title')}"${ctx.delegation ? ` (via ${ctx.delegation.via})` : ''}`);
  return { data: { task: task.data } };
}

module.exports = { propose };
