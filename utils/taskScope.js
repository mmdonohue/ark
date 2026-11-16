'use strict';

// A task's scope — what a run may read, with which capabilities, under which
// constraints, on which drivers. task.approve pins a hash of it; after that
// the scope changes only through task.revise, which sends the task back to
// 'proposed'. harness.run re-checks the hash, so an edit that went around the
// actions (a direct DB write, a sync) still can't run unapproved.

const crypto = require('crypto');

const SCOPE_KEYS = Object.freeze(['inputs', 'required_capabilities', 'constraints', 'execution_policy']);

// Key order and absent-vs-null must not change the hash.
function _canonical(v) {
  if (Array.isArray(v)) return v.map(_canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => (v[k] === undefined ? o : { ...o, [k]: _canonical(v[k]) }), {});
  }
  return v ?? null;
}

function scopeOf(context = {}) {
  return SCOPE_KEYS.reduce((o, k) => ({ ...o, [k]: context[k] ?? null }), {});
}

function scopeHash(context = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonical(scopeOf(context)))).digest('hex');
}

function scopeChanged(before = {}, after = {}) {
  return SCOPE_KEYS.filter(k => JSON.stringify(_canonical(before[k] ?? null)) !== JSON.stringify(_canonical(after[k] ?? null)));
}

// Throws unless the scope is what was approved. A task approved before
// approvals pinned a hash has none: the update lock still covers it from
// here on, and the next task.revise/approve pins one.
function assertApprovedScope(context = {}) {
  const pinned = context.approved?.scope_hash;
  if (pinned && pinned !== scopeHash(context)) {
    throw Object.assign(
      new Error('Task scope changed since it was approved — revise it with task.revise and approve it again'),
      { status: 409, code: 'TASK_SCOPE_CHANGED' },
    );
  }
}

module.exports = { SCOPE_KEYS, scopeOf, scopeHash, scopeChanged, assertApprovedScope };
