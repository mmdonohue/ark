'use strict';

// Workflow definitions: a reusable, ordered plan of governed tasks.
//
//   { alias, title, description?, revision, inputs?: { project_repositories },
//     steps: [{ key, title, mode, body?, acceptance_criteria?, gate?,
//               required_capabilities?, execution_policy?,   // ai
//               kind?, evidence?,                            // human
//               action?, payload? }] }                       // automated
//
// mode says who resolves a step, and what its completion must carry:
//   ai        — a harness run (read-only review); resolves when it succeeds.
//               Completed by hand only with a review this task produced.
//   human     — someone completes it with task.complete. evidence: { note
//               (default true), min_artifacts (default 0), artifact_types? }.
//               kind 'pr' is a PR intent.
//   automated — runs one declared action through dispatch(), as whoever
//               advances the run; only the run resolves it.
// gate: true makes a step wait for its own approval even though the run was
// approved at launch. A PR intent is always gated.
//
// definitionError(def) → null when valid, else the first problem.

const { policyError } = require('./taskScope');

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const STEP_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const CAPABILITY = /^[a-z][a-z_]*\.[a-z_]+$/;
const MODES = new Set(['ai', 'human', 'automated']);
const MAX_STEPS = 20;
const STEP_KEYS = new Set(['key', 'title', 'mode', 'body', 'acceptance_criteria', 'gate', 'required_capabilities', 'execution_policy', 'kind', 'evidence', 'action', 'payload']);
const EVIDENCE_KEYS = new Set(['note', 'min_artifacts', 'artifact_types']);
const ARTIFACT_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const DEF_KEYS = new Set(['alias', 'title', 'description', 'revision', 'inputs', 'steps']);
// An automated step runs as the launcher with no gate of its own, so it may
// only read or add — named action by action. Nothing that archives,
// updates, unrelates, removes, moves or runs a whole pipeline; nothing that
// governs, schedules, records, spends or changes identity. Those stay with
// a person (a human step).
const AUTOMATED_ACTIONS = new Set([
  'artifact.get', 'artifact.list', 'artifact.search', 'artifact.events.list',
  'artifact.create', 'artifact.relate',
  'ark.get', 'ark.list', 'ark.graph', 'ark.add_artifact',
  'media.identify', 'media.fingerprint', 'media.classify.vision', 'media.classify_batch',
  'memchart.assess', 'source.discover',
]);

const _text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const _isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function stepError(s, i, { registered } = {}) {
  const at = `steps[${i}]`;
  if (!_isObject(s)) return `${at} must be an object`;
  const unknown = Object.keys(s).filter(k => !STEP_KEYS.has(k));
  if (unknown.length) return `${at}: unknown field ${unknown.map(k => `"${k}"`).join(', ')}`;
  if (!STEP_KEY.test(s.key || '')) return `${at}.key must be lowercase letters, digits, - or _ (max 40)`;
  if (!_text(s.title, 200)) return `${at}.title is required (max 200)`;
  if (!MODES.has(s.mode)) return `${at}.mode must be ai, human or automated`;
  if (s.body != null && !_text(s.body, 10000)) return `${at}.body must be text (max 10000)`;
  if (s.acceptance_criteria != null
      && (!Array.isArray(s.acceptance_criteria) || s.acceptance_criteria.length > 20 || !s.acceptance_criteria.every(c => _text(c, 500)))) {
    return `${at}.acceptance_criteria must be up to 20 short texts`;
  }
  if (s.gate != null && typeof s.gate !== 'boolean') return `${at}.gate must be true or false`;

  const only = (mode, ...fields) => {
    const bad = fields.filter(f => s[f] != null);
    return s.mode !== mode && bad.length ? `${at}: ${bad.join(', ')} only apply to ${mode} steps` : null;
  };
  const misplaced = only('ai', 'required_capabilities', 'execution_policy') || only('human', 'kind', 'evidence') || only('automated', 'action', 'payload');
  if (misplaced) return misplaced;

  if (s.mode === 'ai') {
    const caps = s.required_capabilities;
    if (caps != null && (!Array.isArray(caps) || !caps.length || caps.length > 8 || !caps.every(c => CAPABILITY.test(c)))) {
      return `${at}.required_capabilities must be 1–8 capability names`;
    }
    if ((caps || []).includes('repo.write')) return `${at}: an ai step runs a read-only review — repo.write belongs to a PR intent (a human step with kind "pr")`;
    if (s.execution_policy != null) {
      const bad = _isObject(s.execution_policy) ? policyError(s.execution_policy) : 'must be an object';
      if (bad) return `${at}.execution_policy: ${bad}`;
      if ('sandbox' in s.execution_policy) return `${at}: sandbox execution is not available in workflow review steps`;
    }
  }
  if (s.mode === 'human' && s.kind != null && s.kind !== 'pr') return `${at}.kind can only be "pr"`;
  if (s.evidence != null) {
    const e = s.evidence;
    if (!_isObject(e) || Object.keys(e).some(k => !EVIDENCE_KEYS.has(k))) return `${at}.evidence may set note, min_artifacts, artifact_types`;
    if (e.note != null && typeof e.note !== 'boolean') return `${at}.evidence.note must be true or false`;
    if (e.min_artifacts != null && !(Number.isInteger(e.min_artifacts) && e.min_artifacts >= 0 && e.min_artifacts <= 20)) return `${at}.evidence.min_artifacts must be 0–20`;
    if (e.artifact_types != null && (!Array.isArray(e.artifact_types) || !e.artifact_types.length || e.artifact_types.length > 10 || !e.artifact_types.every(t => ARTIFACT_TYPE.test(t)))) {
      return `${at}.evidence.artifact_types must be 1–10 artifact type names`;
    }
    if (e.artifact_types && !e.min_artifacts) return `${at}.evidence.artifact_types needs min_artifacts ≥ 1`;
  }
  if (s.mode === 'automated') {
    if (!_text(s.action, 100)) return `${at}.action is required for an automated step`;
    if (!AUTOMATED_ACTIONS.has(s.action)) {
      return `${at}.action "${s.action}" can't be automated — an automated step may only read or add (${[...AUTOMATED_ACTIONS].join(', ')})`;
    }
    if (registered && !registered.has(s.action)) return `${at}.action "${s.action}" is not a registered action`;
    if (s.payload != null && (!_isObject(s.payload) || JSON.stringify(s.payload).length > 10000)) return `${at}.payload must be an object (max 10 KB)`;
  }
  return null;
}

function definitionError(def, opts = {}) {
  if (!_isObject(def)) return 'definition must be an object';
  const unknown = Object.keys(def).filter(k => !DEF_KEYS.has(k));
  if (unknown.length) return `unknown field ${unknown.map(k => `"${k}"`).join(', ')}`;
  if (!ALIAS.test(def.alias || '')) return 'alias must be 1–40 letters, digits, . _ - (starting with a letter or digit)';
  if (!_text(def.title, 200)) return 'title is required (max 200)';
  if (def.description != null && !_text(def.description, 2000)) return 'description must be text (max 2000)';
  if (def.revision != null && !(Number.isInteger(def.revision) && def.revision >= 1)) return 'revision must be a positive integer';
  if (def.inputs != null) {
    if (!_isObject(def.inputs) || Object.keys(def.inputs).some(k => k !== 'project_repositories')) return 'inputs may only set project_repositories';
    const pr = def.inputs.project_repositories;
    if (pr != null && pr !== 'all' && !(Array.isArray(pr) && pr.length && pr.length <= 50 && new Set(pr).size === pr.length && pr.every(a => ALIAS.test(a)))) {
      return 'inputs.project_repositories must be "all" or a list of repository aliases';
    }
  }
  if (!Array.isArray(def.steps) || !def.steps.length || def.steps.length > MAX_STEPS) return `steps must have 1–${MAX_STEPS} entries`;
  const seen = new Set();
  for (const [i, s] of def.steps.entries()) {
    const bad = stepError(s, i, opts);
    if (bad) return bad;
    if (seen.has(s.key)) return `steps[${i}].key "${s.key}" is used twice`;
    seen.add(s.key);
  }
  return null;
}

// The stored form: defaults applied, a PR intent always gated.
function normalize(def) {
  return {
    alias: def.alias,
    title: def.title.trim(),
    ...(def.description ? { description: def.description.trim() } : {}),
    inputs: { project_repositories: def.inputs?.project_repositories ?? 'all' },
    steps: def.steps.map(s => ({
      ...s,
      title: s.title.trim(),
      gate: s.kind === 'pr' ? true : !!s.gate,
      ...(s.mode === 'ai' ? { required_capabilities: s.required_capabilities || ['repo.read'] } : {}),
      ...(s.mode === 'human' ? { evidence: { note: true, min_artifacts: 0, ...(s.evidence || {}) } } : {}),
    })),
  };
}

// What task.complete must carry for a workflow step (definition snapshot
// `step`). Returns an error message, or null. reviewIds: reviews this task
// produced (only those count as an ai step's evidence).
function completionError(step, { note, artifacts = [] }, { types = {}, reviewIds = new Set() } = {}) {
  if (step.mode === 'automated') return 'an automated step is resolved by its run, not by hand';
  if (step.mode === 'ai') {
    return artifacts.some(id => reviewIds.has(id)) ? null
      : 'an ai step is completed by its review: run it, or attach a review this task produced';
  }
  // A snapshot from before evidence existed has none: no requirement, as
  // when it was launched. normalize() gives every new definition one.
  if (!step.evidence) return null;
  const e = { note: true, min_artifacts: 0, ...step.evidence };
  if (e.note && !(typeof note === 'string' && note.trim())) return 'this step needs a note saying what was done';
  const counted = e.artifact_types ? artifacts.filter(id => e.artifact_types.includes(types[id])) : artifacts;
  if (counted.length < (e.min_artifacts || 0)) {
    return `this step needs at least ${e.min_artifacts} evidence artifact${e.min_artifacts === 1 ? '' : 's'}${e.artifact_types ? ` of type ${e.artifact_types.join(' or ')}` : ''}`;
  }
  return null;
}

module.exports = { definitionError, stepError, normalize, completionError, ALIAS, MAX_STEPS, AUTOMATED_ACTIONS };
