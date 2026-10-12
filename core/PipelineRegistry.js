'use strict';

// PipelineRegistry — registers a pipeline recipe directory (pipeline.yaml +
// memchart.yaml + rules/*.yaml) as real artifacts: artifact_type 'pipeline'
// and 'memchart'. Per the charter (§40/§41): the directory is the authoring/
// distribution format; the artifact is canonical. Rule file references get
// inlined into the pipeline artifact's metadata at registration time, so the
// artifact is self-contained and portable even if the original directory
// isn't around later (e.g. synced to a vessel that never had the source
// files) — metadata.rule_sources keeps the original file paths for
// provenance, but resolution never depends on them existing.
//
// Idempotent by slug: unchanged content just re-saves (content_hash comes
// out the same via Artifact.prepare()'s existing fingerprint — no separate
// hash tracking needed). No dispatch()/capability gating here, same as
// cli/localIdentity.js — this runs as part of vessel provisioning, before
// there's necessarily anyone to authorize it against.

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const Artifact = require('../domain/Artifact');

function _readYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function _resolveRules(dir, ruleRefs) {
  if (!Array.isArray(ruleRefs)) return { rules: [], rule_sources: [] };
  const rules = [];
  const rule_sources = [];
  for (const ref of ruleRefs) {
    const full = path.join(dir, ref);
    const doc = _readYaml(full);
    if (doc?.rules) rules.push(...doc.rules);
    rule_sources.push(ref);
  }
  return { rules, rule_sources };
}

async function _upsertArtifact({ artifact_type, slug, title, metadata, ctx }) {
  const existing = await Artifact.query(
    { artifact_type, filters: [['slug', 'eq', slug]] },
    ctx,
  );

  if (existing.length) {
    const artifact = new Artifact({ id: existing[0].id }, { context: ctx });
    artifact.assign({ metadata, title });
    await artifact.save();
    return artifact.data;
  }

  const artifact = new Artifact({
    artifact_type,
    title,
    slug,
    status:   'published',
    metadata,
    context:  { visibility: 'private' },
  }, { context: ctx });
  await artifact.save();
  return artifact.data;
}

// Registers one recipe directory. Returns { pipeline, memchart } — memchart
// is null if the recipe doesn't have one (e.g. pipelines/classify).
async function registerDirectory(dir, ctx) {
  const pipelineDoc = _readYaml(path.join(dir, 'pipeline.yaml'));
  if (!pipelineDoc) throw new Error(`No pipeline.yaml in ${dir}`);

  const { rules, rule_sources } = _resolveRules(dir, pipelineDoc.rules);

  const pipeline = await _upsertArtifact({
    artifact_type: 'pipeline',
    slug:          pipelineDoc.slug,
    title:         pipelineDoc.slug,
    metadata:      { ...pipelineDoc, rules, rule_sources },
    ctx,
  });

  const memchartDoc = _readYaml(path.join(dir, 'memchart.yaml'));
  let memchart = null;
  if (memchartDoc) {
    memchart = await _upsertArtifact({
      artifact_type: 'memchart',
      slug:          memchartDoc.slug,
      title:         memchartDoc.title || memchartDoc.slug,
      metadata:      memchartDoc,
      ctx,
    });
  }

  return { pipeline, memchart };
}

// Registers a standalone memchart.yaml — one with no sibling pipeline.yaml,
// e.g. ark/memcharts/archive/memchart.yaml. Interpretive charts aren't only
// useful attached to an import pipeline (see registerDirectory) — a
// UI-driven destination like the Archive Ark still benefits from declaring
// what it means and how a future process should treat its contents, even
// with no pipeline of its own to run yet. Reuses the same _upsertArtifact
// path, so it's idempotent/re-registerable exactly like a pipeline's memchart.
async function registerMemchartFile(filePath, ctx) {
  const memchartDoc = _readYaml(filePath);
  if (!memchartDoc) throw new Error(`No memchart.yaml at ${filePath}`);

  return _upsertArtifact({
    artifact_type: 'memchart',
    slug:          memchartDoc.slug,
    title:         memchartDoc.title || memchartDoc.slug,
    metadata:      memchartDoc,
    ctx,
  });
}

// Registers every recipe named in `slugs`, resolved under `pipelinesDir`
// (default: backend/pipelines). Skips silently (with a warning) if a named
// recipe directory doesn't exist — a persona manifest can list recipes that
// haven't been built yet without breaking provisioning for the ones that have.
async function registerRecipes(slugs, ctx, pipelinesDir = path.resolve(__dirname, '../pipelines')) {
  const results = [];
  for (const slug of slugs) {
    const dir = path.join(pipelinesDir, slug);
    if (!fs.existsSync(path.join(dir, 'pipeline.yaml'))) {
      console.warn(`[PipelineRegistry] skipping "${slug}" — no pipeline.yaml at ${dir}`);
      continue;
    }
    results.push(await registerDirectory(dir, ctx));
  }
  return results;
}

module.exports = { registerDirectory, registerRecipes, registerMemchartFile };
module.exports._internals = { _resolveRules, _readYaml };
