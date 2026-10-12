'use strict';

// ClassifyActions — implements media.classify.vision, the sole capability of
// pipelines/classify (see providers.yaml there for the model binding). A
// governed ARK action calling the Manifest 'llm' service — not an executable
// provider, per §41.4: an LLM call is a capability-scoped internal service
// binding, not spawned code, so it doesn't need executor resolution.

const fs   = require('fs');
const path = require('path');

const Packet   = require('../core/Packet');
const Artifact = require('../domain/Artifact');
const { getManifest } = require('../core/bootstrap');

const RECIPE_DIR    = path.resolve(__dirname, '../pipelines/classify');
const PROMPT_PATH    = path.join(RECIPE_DIR, 'prompts/classify.md');

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif' };

// Resolved by input+verb (ServicesAdapter.resolve — see
// .claude/plans/ark/ark_goals.md Pass 1) instead of reading
// providers.yaml directly — the point is that this call site never
// changes even if a second "photo classify" provider (a local model,
// GLiNER, etc.) gets added later; only providers.yaml would.
function _providerConfig() {
  return getManifest().get('services').resolve({ input: 'photo', verb: 'classify' });
}

function _buildPrompt(candidateSubjects) {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  return template.replace('{{candidate_subjects}}', (candidateSubjects || []).join(', ') || '(none — classify openly)');
}

// payload: { source_path, candidate_subjects? }
async function classifyVision(ctx, payload, packet) {
  const { source_path, candidate_subjects = [] } = payload;
  if (!source_path) throw new Error('source_path is required');
  if (!fs.existsSync(source_path)) throw new Error(`File does not exist: ${source_path}`);

  const provider = _providerConfig();
  const ext = path.extname(source_path).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const base64 = fs.readFileSync(source_path).toString('base64');

  const llm = Packet.service('llm');
  const result = await llm.complete({
    model: provider.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: _buildPrompt(candidate_subjects) },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    }],
    max_tokens: 100,
    temperature: 0,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.content.trim().replace(/^```json\s*|\s*```$/g, ''));
  } catch {
    parsed = { likely_subject: 'unknown', confidence: 0 };
  }

  packet.log.push(`media.classify.vision → ${path.basename(source_path)}: ${parsed.likely_subject} (${parsed.confidence})`);
  return { data: { likely_subject: parsed.likely_subject || 'unknown', confidence: parsed.confidence ?? 0, model_used: result.model_used } };
}

// ── media.classify_batch — observe ────────────────────────────────────────
// pipelines/classify's single capability (media.classify.vision) takes one
// file. usb-sd-birds operates on a batch (payload.files). True generic
// pipeline-composition-with-fan-out (invoking a single-item child pipeline
// once per item in a batch) isn't built — this is the deliberate, smaller
// stand-in: calls the same classification logic per file directly. Revisit
// if/when a second batch pipeline needs the same pattern.
const TIF_EXTS = new Set(['tif', 'tiff']);

async function classifyBatch(ctx, payload, packet) {
  const { files = [], candidate_subjects = [] } = payload;
  const classified = [];
  let skipped = 0;
  let inheritedFromExisting = 0;
  for (const f of files) {
    // Hard guard, independent of media.pair (an optional pipeline stage
    // that can be skipped): TIFF is always the hi-res archival master,
    // cold storage only. Never sent to the vision model, and — unlike an
    // earlier version of this guard — never inherits its JPG twin's
    // result either: a TIFF has zero viewable bytes, so giving it a
    // likely_subject just meant it could match birds/ephemera routing and
    // get its own near-blank gallery tile (confirmed live). It has no
    // subject of its own; routing.yaml's archival-master-stays-cold rule
    // is what actually keeps it out of public buckets, not this.
    if (TIF_EXTS.has((f.ext || '').toLowerCase())) {
      classified.push({ ...f, classified: false, representation_role: f.representation_role || 'archival_master' });
      skipped++;
      continue;
    }
    // A re-encountered duplicate whose earlier run already classified and
    // persisted a result (see the persist call below) — inherit it rather
    // than re-spending an LLM call on a photo already resolved. Checked
    // before needs_classification so it wins even if this run's capture-year
    // filter would otherwise have skipped it.
    if (f.existing_classification) {
      classified.push({
        ...f,
        likely_subject: f.existing_classification.likely_subject,
        confidence:     f.existing_classification.confidence,
        classified:     true,
        inherited_classification: true,
      });
      inheritedFromExisting++;
      continue;
    }
    // needs_classification is set by source.filter (undefined only for
    // callers that never ran that stage) — anything explicitly false is
    // correctly-dated media that doesn't need the LLM, per
    // rules/source-selection.yaml. (paired_with is TIFF-only, and TIFF is
    // already handled above, so this is never reached for a paired file.)
    if (f.needs_classification === false) {
      classified.push({ ...f, classified: false });
      skipped++;
      continue;
    }
    try {
      const { data } = await classifyVision(ctx, { source_path: f.source_path, candidate_subjects }, packet);
      classified.push({ ...f, likely_subject: data.likely_subject, confidence: data.confidence, classified: true });
      // Persist onto the artifact (new or duplicate — both carry artifact_id
      // by this stage) so the NEXT encounter of this same photo can inherit
      // via existing_classification above instead of re-classifying. Never
      // persist 'unknown' — classifyVision's own catch returns that sentinel
      // for a response it couldn't parse as JSON, not a real "not a bird"
      // judgment (confirmed empirically: the free-tier model returned
      // 'unknown' once and 'birds'/0.95 twice for the identical image on
      // back-to-back calls — a formatting hiccup, not model consensus).
      // Persisting it would wrongly lock a real photo out of ever being
      // reclassified on a later run.
      if (f.artifact_id && data.likely_subject !== 'unknown') {
        await _persistClassification(ctx, f.artifact_id, data.likely_subject, data.confidence);
      }
    } catch (err) {
      packet.log.push(`media.classify_batch → ${f.basename} failed: ${err.message}`);
      // Not persisted — an LLM/network failure isn't a real classification;
      // the next run should retry, not inherit "unknown" forever.
      classified.push({ ...f, likely_subject: 'unknown', confidence: 0, classified: true });
    }
  }

  const newlyClassified = classified.filter(f => f.classified && !f.inherited_classification).length;
  packet.log.push(`media.classify_batch → ${newlyClassified} classified, ${inheritedFromExisting} inherited from prior run, ${skipped} skipped (TIFF or not flagged)`);
  return { data: { files: classified } };
}

// Read-modify-write: metadata is a whole-object column, so an unconditional
// assign would wipe source_mtime/media_type/ext already stored there by
// media.preserve. Not scoped to only-first-classification-wins — a later
// run re-classifying (e.g. after a prompt/model change) just overwrites.
async function _persistClassification(ctx, artifactId, likely_subject, confidence) {
  const { data: row } = await Artifact.db.from('artifacts').select('metadata').eq('id', artifactId).maybeSingle();
  const artifact = new Artifact({ id: artifactId }, { context: ctx });
  artifact.assign({ metadata: { ...(row?.metadata || {}), likely_subject, confidence } });
  await artifact.save();
}

module.exports = { classifyVision, classifyBatch };
