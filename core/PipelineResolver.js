'use strict';

// PipelineResolver — compiles a registered `pipeline` artifact's stages into
// the hook-list ChainExecutor.run() already accepts. Per §22 of the charter:
// "Pipeline describes composition and intent. Chain records durable
// execution." This is the resolution step between the two — deliberately
// thin, reuses ChainExecutor rather than building a second runtime.

const Artifact       = require('../domain/Artifact');
const ChainExecutor  = require('./ChainExecutor');

// Stage-level `pipeline: <slug>` references a child pipeline. True generic
// fan-out (invoking a single-item child once per item in a batch) isn't
// built — see ClassifyActions.classifyBatch. This maps the one case that
// exists today explicitly, rather than pretending to generalize it.
const CHILD_PIPELINE_OVERRIDES = {
  classify: 'media.classify_batch',
};

function compileHooks(pipelineDoc) {
  return pipelineDoc.stages.map(stage => {
    let action;
    if (stage.capability) {
      action = stage.capability;
    } else if (stage.pipeline) {
      action = CHILD_PIPELINE_OVERRIDES[stage.pipeline];
      if (!action) throw new Error(`No runtime mapping for child pipeline stage "${stage.id}" (pipeline: ${stage.pipeline})`);
    } else {
      throw new Error(`Stage "${stage.id}" declares neither capability nor pipeline`);
    }
    // retry is opt-in per stage, absent by default — a stage with a real
    // side effect (e.g. sending an email) must explicitly declare retry;
    // silently retrying something non-idempotent is a worse failure mode
    // than the original error.
    return { action, optional: !!stage.optional, retry: stage.retry || null };
  });
}

// slug           — the registered pipeline artifact's slug (e.g. 'usb-sd-birds')
// initialPayload — stage inputs (e.g. { path, media_types, source_metadata, candidate_subjects })
// ctx, registry  — same as dispatch()'s ctx and ACTION_REGISTRY
async function runPipeline({ slug, initialPayload = {}, ctx, registry }) {
  const [pipelineArtifact] = await Artifact.query(
    { artifact_type: 'pipeline', filters: [['slug', 'eq', slug]] },
    ctx,
  );
  if (!pipelineArtifact) throw new Error(`Pipeline not registered: ${slug} (run "ark rescan" first)`);

  const pipelineDoc = pipelineArtifact.metadata;
  const hooks = compileHooks(pipelineDoc);

  let memchart_doc = null;
  if (pipelineDoc.memchart) {
    const [memchartArtifact] = await Artifact.query(
      { artifact_type: 'memchart', filters: [['slug', 'eq', pipelineDoc.memchart]] },
      ctx,
    );
    memchart_doc = memchartArtifact?.metadata || null;
  }

  // candidate_subjects for classify defaults from the memchart's own
  // memory.value list — a caller shouldn't have to retype what the
  // pipeline's own memchart already declares it cares about. Explicit
  // initialPayload.candidate_subjects still wins if given.
  const defaultCandidateSubjects = memchart_doc?.memory?.value || [];

  const payload = {
    candidate_subjects: defaultCandidateSubjects,
    ...initialPayload,
    pipeline_slug:  slug,
    pipeline_rules: pipelineDoc.rules || [],
    memchart_doc,
  };

  const result = await ChainExecutor.run({
    hooks,
    originAction: `pipeline.run:${slug}`,
    payload,
    ctx,
    registry,
  });

  return { pipeline: { id: pipelineArtifact.id, slug }, ...result };
}

module.exports = { compileHooks, runPipeline };
