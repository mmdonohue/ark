'use strict';

// Workflow definitions: a reusable, ordered plan of governed tasks.
//
//   { alias, title, description?, revision, inputs?: { project_repositories },
//     steps: [{ key, title, mode, body?, acceptance_criteria?, gate?,
//               required_capabilities?, execution_policy?,   // ai
//               kind?,                                       // human: 'pr'
//               action?, payload? }] }                       // automated
//
// mode says who resolves a step:
//   ai        — a harness run (read-only review); completes when it succeeds
//   human     — someone completes it with evidence; kind 'pr' is a PR intent
//   automated — runs one declared action, as the launcher, through dispatch()
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
const STEP_KEYS = new Set(['key', 'title', 'mode', 'body', 'acceptance_criteria', 'gate', 'required_capabilities', 'execution_policy', 'kind', 'action', 'payload']);
const DEF_KEYS = new Set(['alias', 'title', 'description', 'revision', 'inputs', 'steps']);
// An automated step runs as the launcher, but never the lifecycle or the
// machinery that governs it: approving, running agents, launching workflows,
// identities and sync stay with a person.
const AUTOMATED_DENIED = /^(task|workflow|harness|repository|ark_actor|sync|ledger)\./;

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
  const misplaced = only('ai', 'required_capabilities', 'execution_policy') || only('human', 'kind') || only('automated', 'action', 'payload');
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
    }
  }
  if (s.mode === 'human' && s.kind != null && s.kind !== 'pr') return `${at}.kind can only be "pr"`;
  if (s.mode === 'automated') {
    if (!_text(s.action, 100)) return `${at}.action is required for an automated step`;
    if (AUTOMATED_DENIED.test(s.action)) return `${at}.action "${s.action}" can't be automated — it governs the work itself`;
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
    })),
  };
}

module.exports = { definitionError, stepError, normalize, ALIAS, MAX_STEPS };
