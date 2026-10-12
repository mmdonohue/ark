'use strict';

const fs   = require('fs');
const path = require('path');
const { runPipeline }       = require('../core/PipelineResolver');
const { registerDirectory } = require('../core/PipelineRegistry');
const Artifact = require('../domain/Artifact');

const PIPELINES_DIR = path.resolve(__dirname, '../pipelines');

// pipeline.run — payload: { pipeline_slug, ...initialPayload }
// initialPayload flows straight into the pipeline's stages as-is (path,
// media_types, source_metadata, candidate_subjects, ...) — this action is
// intentionally thin; PipelineResolver does the real work.
async function run(ctx, payload, packet) {
  const { pipeline_slug, ...initialPayload } = payload;
  if (!pipeline_slug) throw new Error('pipeline_slug is required');

  // Lazy-required to avoid a circular dependency with core/dispatch.js,
  // same pattern as WorkflowActions.getRegistry().
  const { ACTION_REGISTRY: REGISTRY } = require('../core/dispatch');

  const result = await runPipeline({ slug: pipeline_slug, initialPayload, ctx, registry: REGISTRY });

  packet.log.push(`pipeline.run → ${pipeline_slug}: ${result.status} (${result.resolution})`);
  return { data: result };
}

// pipeline.list — no payload. Cross-references recipe directories on disk
// (the authoring/distribution format — see PipelineRegistry.js's header
// comment) against what's actually registered as a real pipeline artifact
// in THIS store's db, so the UI can show "registered" vs. "needs
// registering" per recipe rather than just one or the other. Only
// directories with a pipeline.yaml count as a recipe — e.g. ark-dev is
// memchart-only and isn't offered here.
async function list(ctx, payload, packet) {
  const slugs = fs.existsSync(PIPELINES_DIR)
    ? fs.readdirSync(PIPELINES_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(PIPELINES_DIR, e.name, 'pipeline.yaml')))
        .map(e => e.name)
    : [];

  const registered = await Artifact.query({ artifact_type: 'pipeline' }, ctx);
  const registeredBySlug = new Map(registered.map(p => [p.slug, p]));

  const pipelines = slugs.map(slug => {
    const reg = registeredBySlug.get(slug);
    return {
      slug,
      registered: !!reg,
      stage_count: reg?.metadata?.stages?.length ?? null,
      updated_at: reg?.updated_at || null,
    };
  });

  packet.log.push(`pipeline.list → ${pipelines.length} recipe(s), ${pipelines.filter(p => p.registered).length} registered`);
  return { data: { pipelines } };
}

// pipeline.register — payload: { slug }. Registers (or re-registers, if
// the recipe's yaml changed) one recipe directory as a real artifact —
// the UI-triggered equivalent of running
// backend/ark/scripts/register-pipeline.js by hand. Idempotent by slug,
// same as PipelineRegistry.registerDirectory itself.
async function register(ctx, payload, packet) {
  const { slug } = payload;
  if (!slug) throw new Error('slug is required');

  const dir = path.join(PIPELINES_DIR, slug);
  if (!fs.existsSync(path.join(dir, 'pipeline.yaml'))) {
    throw Object.assign(new Error(`No pipeline.yaml for recipe "${slug}"`), { status: 404 });
  }

  const { pipeline, memchart } = await registerDirectory(dir, ctx);

  packet._objects['pipeline'] = pipeline;
  packet.log.push(`pipeline.register → ${slug} (${pipeline.id})${memchart ? ' + memchart' : ''}`);
  return { data: { pipeline, memchart } };
}

module.exports = { run, list, register };
