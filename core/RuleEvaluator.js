'use strict';

// RuleEvaluator — the generic mechanism behind "pipelines are rule engines"
// (CHARTER.md §41.1). Ordered, single-pass, accumulating
// evaluation over a fact object — deliberately not a forward-chaining engine.
// Any stage capability hands it the pipeline's inlined rules + its own facts;
// this file has no domain knowledge of birds, media, or anything else.
//
// Only a subset of the condition vocabulary used in pipelines/usb-sd-birds/
// rules/*.yaml is implemented: in, not, below, above, exists, already_exists,
// and plain equality. Conditions this can't evaluate (files_share, formats,
// or) return false — the rule just doesn't fire, rather than crashing.
// Extend this as real pipelines actually need more, not speculatively.

function evaluateRules(rules, facts) {
  let ctx = { ...facts };
  const applied = [];
  for (const rule of rules || []) {
    if (_matchesAll(rule.when, ctx)) {
      ctx = { ...ctx, ..._flattenThen(rule.then) };
      applied.push(rule.id);
    }
  }
  return { result: ctx, applied };
}

function _matchesAll(when, facts) {
  if (!when) return true;
  for (const [key, cond] of Object.entries(when)) {
    if (!_matchCond(cond, _get(facts, key))) return false;
  }
  return true;
}

function _matchCond(cond, val) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond)             return Array.isArray(cond.in) && cond.in.includes(val);
    if ('not' in cond)            return val !== undefined && val !== cond.not; // absent is not "not X" — it's unknown
    if ('below' in cond)          return typeof val === 'number' && val < cond.below;
    if ('above' in cond)          return typeof val === 'number' && val > cond.above;
    if ('exists' in cond)         return cond.exists ? (val !== undefined && val !== null) : (val === undefined || val === null);
    if ('already_exists' in cond) return !!val === cond.already_exists;
    return false; // unsupported condition shape (files_share, formats, or, ...) — rule doesn't fire
  }
  return val === cond;
}

// `then` blocks can nest (e.g. annotate: { capture_date: {...} }) — flatten
// one level of nesting isn't needed for fact accumulation; top-level keys
// are what later rules/stages actually read (route_to_bucket, role, etc).
function _flattenThen(then) {
  return { ...(then || {}) };
}

function _get(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

module.exports = { evaluateRules };
