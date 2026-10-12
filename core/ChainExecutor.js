// ChainExecutor — runs a durable packet chain from a list of action hooks.
// Each step is persisted before execution so chains survive process restarts.
// Resume is called at startup to re-execute any chains interrupted by a crash.

const ArtifactChain     = require('../domain/ArtifactChain');
const ArtifactChainStep = require('../domain/ArtifactChainStep');

class ChainExecutor {

  // Run a new chain from a list of action hooks.
  // hooks: (string | { action, optional, retry })[] — ACTION_REGISTRY keys to
  //   execute in order. Plain strings are non-optional, same as before this
  //   shape existed. optional:true means a thrown error fails that step but
  //   not the whole chain (pipeline.yaml's "optional-stage failure may
  //   produce partial resolution" invariant) — needed once a stage can be a
  //   real network call (e.g. media.classify_batch) that can genuinely fail.
  // retry: { max, backoff_ms }|null — comes from the stage's own pipeline.yaml
  //   entry (see PipelineResolver.compileHooks). Absent/null means one
  //   attempt, same as today — a stage must opt into retry, since a step
  //   like "send email" retrying blindly can double-send.
  // payload: object         — initial payload; each step receives the merged output of all prior steps
  // ctx: object             — execution context (user_id, store_id, request_id, …)
  // registry: object        — ACTION_REGISTRY from action.js
  // response: object|null   — contract response block (type, payload, resolution criteria)
  static async run({ hooks, originAction, payload, ctx, registry, response = null }) {
    if (!hooks?.length) return null;

    const normalized = hooks.map(h => typeof h === 'string' ? { action: h, optional: false, retry: null } : { retry: null, ...h });

    const chain = new ArtifactChain({
      store_id:     ctx.store_id   || null,
      principal_id: ctx.user_id    || null,
      action:       originAction,
      status:       'pending',
      context: {
        request_id:  ctx.request_id  || null,
        template_id: payload.template_id || null,
        domain_id:   payload.domain_id   || null,
        artifact_id: payload.artifact_id || null,
      },
    }, { context: ctx });

    await chain.save();
    await chain.start();

    // Persist all steps up-front — chain is fully recorded before execution begins.
    // Only the action name is persisted; optionality is a resolution-time
    // concern, not part of the durable step record (resume() re-runs with
    // every step treated as non-optional — a known, accepted simplification).
    const steps = [];
    for (let i = 0; i < normalized.length; i++) {
      const step = new ArtifactChainStep({
        chain_id:   chain.id,
        step_index: i,
        action:     normalized[i].action,
        status:     'pending',
        input:      { ...payload },
      }, { context: ctx });
      await step.save();
      steps.push(step);
    }

    return ChainExecutor._executeSteps(
      chain, steps, payload, ctx, registry, response,
      normalized.map(h => h.optional),
      normalized.map(h => h.retry),
    );
  }

  // Execute steps sequentially.
  // Returns { chain_id, status, resolution, data, error? }
  // retryConfigs[i] is null (one attempt) unless the stage opted in — see run()'s comment above.
  static async _executeSteps(chain, steps, initialPayload, ctx, registry, response = null, optionalFlags = [], retryConfigs = []) {
    let currentPayload    = { ...initialPayload };
    let anySkipped        = false;
    let anyOptionalFailed = false;
    const chainArtifactId = chain.get('context')?.artifact_id || null;

    for (let i = 0; i < steps.length; i++) {
      const step        = steps[i];
      const isOptional  = optionalFlags[i] || false;
      const retryConfig = retryConfigs[i] || null;
      const maxAttempts = retryConfig?.max > 1 ? retryConfig.max : 1;
      const backoffMs   = retryConfig?.backoff_ms || 0;
      const action      = step.get('action');
      const handlerDef  = registry[action];
      const handler     = handlerDef?.handler || (typeof handlerDef === 'function' ? handlerDef : null);

      if (!handler) {
        await step.assign({ status: 'skipped' }).save();
        anySkipped = true;
        continue;
      }

      await step.start();

      let lastErr   = null;
      let succeeded = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const innerPacket = { _objects: {}, events: {}, log: [] };
          const result = await handler(ctx, currentPayload, innerPacket);
          await step.complete(result?.data || null);
          if (result?.data) currentPayload = { ...currentPayload, ...result.data };
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err;
          await _recordChainEvent(ctx, {
            artifact_id: chainArtifactId,
            chain_id:    chain.id,
            event_type:  'chain.step_attempt',
            event_name:  attempt < maxAttempts ? 'Pipeline step failed, retrying' : 'Pipeline step failed',
            payload:     { action, step_index: i, attempt, max_attempts: maxAttempts, error: err.message },
          });
          if (attempt < maxAttempts) {
            if (backoffMs) await _sleep(backoffMs * attempt); // linear backoff
          }
        }
      }

      if (!succeeded) {
        await step.fail(lastErr);
        if (isOptional) {
          anyOptionalFailed = true;
          continue; // partial resolution, not chain failure — this step was declared optional
        }
        await chain.fail(lastErr);
        return { chain_id: chain.id, status: 'failed', resolution: 'failure', error: lastErr.message };
      }
    }

    const resolution = _evaluateResolution(anySkipped || anyOptionalFailed, response?.resolution);
    await chain.complete(resolution);

    const data = _shapePayload(currentPayload, response?.payload);
    return { chain_id: chain.id, status: 'completed', resolution, type: response?.type || null, data };
  }

  // Resume any chains that were interrupted by a process restart.
  // Call at startup after Packet.configure(manifest) has been called.
  // registry: ACTION_REGISTRY — injected to avoid circular dependencies
  static async resume(registry) {
    let chains;
    try {
      const { data } = await ArtifactChain.db
        .from('artifact_chains')
        .select('*')
        .in('status', ['pending', 'running'])
        .limit(50);
      chains = data;
    } catch (err) {
      console.error(`  ✗ ChainExecutor resume query failed: ${err.message}`);
      return;
    }

    if (!chains?.length) return;

    console.log(`  ○ ChainExecutor resuming ${chains.length} chain(s)`);

    for (const chainRow of chains) {
      const { data: stepRows } = await ArtifactChain.db
        .from('artifact_chain_steps')
        .select('*')
        .eq('chain_id', chainRow.id)
        .order('step_index', { ascending: true });

      if (!stepRows?.length) continue;

      // Reset any "running" steps back to pending (they were interrupted)
      const toReset = stepRows.filter(s => s.status === 'running');
      for (const s of toReset) {
        await ArtifactChain.db
          .from('artifact_chain_steps')
          .update({ status: 'pending', started_at: null })
          .eq('id', s.id);
      }

      const pendingSteps = stepRows
        .filter(s => s.status === 'pending' || s.status === 'running')
        .map(s => ({ ...s, status: 'pending' }));

      if (!pendingSteps.length) continue;

      const ctx = {
        store_id:   chainRow.store_id,
        user_id:    chainRow.principal_id,
        request_id: chainRow.context?.request_id,
        source:     'resume',
      };

      const chain = new ArtifactChain(chainRow, { context: ctx });
      const steps = pendingSteps.map(s => new ArtifactChainStep(s, { context: ctx }));
      const initialPayload = pendingSteps[0]?.input || {};

      // Fire-and-forget — don't block startup
      setImmediate(() => {
        ChainExecutor._executeSteps(chain, steps, initialPayload, ctx, registry)
          .catch(err => console.error(`  ✗ ChainExecutor resume chain=${chainRow.id}: ${err.message}`));
      });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Maps execution outcome to a resolution label using criteria declared in
// the contract's response.resolution block (or sensible defaults).
function _evaluateResolution(anySkipped, criteria = {}) {
  const successLabel = criteria.success || 'all_steps_completed';
  const partialLabel = criteria.partial || 'some_steps_skipped';
  if (anySkipped) return partialLabel;
  return successLabel;
}

// Filter the accumulated payload to only the keys declared in response.payload.
// If payload is empty or not declared, returns the full accumulated payload.
function _shapePayload(data, payloadKeys) {
  if (!payloadKeys?.length) return data;
  const shaped = {};
  for (const key of payloadKeys) {
    if (data[key] !== undefined) shaped[key] = data[key];
  }
  return shaped;
}

// Best-effort attempt/retry log — same fire-and-forget posture as
// ledger.close (see ChainExecutor's own header comment on durability).
// artifact_events.artifact_id/store_id are NOT NULL, so a chain with
// neither (nothing in payload.artifact_id, no ctx.store_id) has nowhere
// to attach the event; silently skipped rather than failing the step.
async function _recordChainEvent(ctx, { artifact_id, chain_id, event_type, event_name, payload = {} }) {
  if (!artifact_id) return;
  try {
    await ArtifactChain.db.from('artifact_events').insert({
      store_id:    ctx?.store_id || null,
      artifact_id,
      actor_id:    ctx?.user_id || null,
      event_type,
      event_name,
      payload,
      chain_id,
    });
  } catch {
    // best-effort — never block chain execution on event logging
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = ChainExecutor;
module.exports._internals = { _evaluateResolution, _shapePayload };
