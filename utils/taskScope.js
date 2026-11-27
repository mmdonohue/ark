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

// execution_policy: {
//   drivers?:  ['copilot', { name: 'claude', model: 'opus' }]  // ordered; failover walks it
//   driver?:   'claude'          // a single pin (older shape; not with drivers)
//   model?:    '...'             // default model for entries that don't name one
//   failover?: boolean           // default true
//   sandbox?:  { runtime, network, image, timeout_ms }  // reserved writable scope
// }
// Returns an error message, or null when the shape is valid. Unknown keys
// are refused so a typo can't silently fall back to the global order.
const POLICY_KEYS = new Set(['drivers', 'driver', 'model', 'failover', 'sandbox']);
const MAX_DRIVERS = 8;
const _str = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 100;
const SANDBOX_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64}$/;

function policyError(policy) {
  if (policy == null) return null;
  if (typeof policy !== 'object' || Array.isArray(policy)) return 'execution_policy must be an object';
  const unknown = Object.keys(policy).filter(k => !POLICY_KEYS.has(k));
  if (unknown.length) return `execution_policy: unknown ${unknown.join(', ')} (allowed: ${[...POLICY_KEYS].join(', ')})`;
  if ('sandbox' in policy) {
    const s = policy.sandbox;
    if (!s || typeof s !== 'object' || Array.isArray(s)
        || Object.keys(s).some(k => !['runtime', 'network', 'image', 'timeout_ms'].includes(k))
        || s.runtime !== 'apple-container' || s.network !== 'none'
        || typeof s.image !== 'string' || s.image.length > 512 || !SANDBOX_IMAGE.test(s.image)
        || !Number.isInteger(s.timeout_ms) || s.timeout_ms < 1 || s.timeout_ms > 2147483647) {
      return 'execution_policy.sandbox requires apple-container, network none, a sha256-pinned image and a positive timeout_ms';
    }
    if (['driver', 'drivers', 'model', 'failover'].some(k => k in policy)) {
      return 'execution_policy.sandbox cannot be combined with a review driver policy';
    }
  }
  if (policy.driver != null && !_str(policy.driver)) return 'execution_policy.driver must be a driver name';
  if (policy.model != null && !_str(policy.model)) return 'execution_policy.model must be a model name';
  if (policy.failover != null && typeof policy.failover !== 'boolean') return 'execution_policy.failover must be true or false';
  if (policy.drivers != null) {
    if (policy.driver != null) return 'execution_policy: set drivers or driver, not both';
    const list = policy.drivers;
    if (!Array.isArray(list) || !list.length || list.length > MAX_DRIVERS) return `execution_policy.drivers must list 1–${MAX_DRIVERS} drivers`;
    const names = [];
    for (const e of list) {
      const name = typeof e === 'string' ? e : e?.name;
      if (!_str(name)) return 'execution_policy.drivers entries are a name or { name, model? }';
      if (typeof e === 'object' && (Object.keys(e).some(k => k !== 'name' && k !== 'model') || (e.model != null && !_str(e.model)))) {
        return `execution_policy.drivers: entry "${name}" may only have name and model`;
      }
      names.push(name);
    }
    if (new Set(names).size !== names.length) return 'execution_policy.drivers lists a driver twice';
  }
  return null;
}

// The ordered [{ name, model? }] a policy asks for, or null for "any
// configured driver, in config order".
function driverOrder(policy = {}) {
  if (policy.drivers) return policy.drivers.map(e => (typeof e === 'string' ? { name: e } : { name: e.name, ...(e.model ? { model: e.model } : {}) }));
  if (policy.driver) return [{ name: policy.driver }];
  return null;
}

module.exports = { SCOPE_KEYS, scopeOf, scopeHash, scopeChanged, assertApprovedScope, policyError, driverOrder };
