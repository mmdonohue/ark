'use strict';

// hostActions — actions an embedding app adds to ARK without editing core.
//
// Declared in ark.host.js (see core/host.js) and registered by bootstrap():
//
//   actions: {
//     'shop.refund': { capability: 'shop.write', handler },          // new action
//     'catalog.generate_sale_code': { capability: 'catalog.write',   // replaces core's
//                                     handler, override: true },
//   },
//   capabilities: { 'shop.write': { min_rank: 100 }, 'shop.view': { guest: true } },
//
// A host action is dispatched exactly like a core one: PCER, the capability
// check, the ledger. Its capability is granted for that action (TraceActions),
// subject to the policy declared for it. Two rules keep core's guarantees:
//   - replacing a core action needs override: true, so it is never accidental
//   - policy can only be declared for capabilities core doesn't use; a host
//     uses core capabilities as core governs them, it can't loosen them

let _actions = new Map();
let _policy  = new Map();

function register({ actions = {}, capabilities = {} } = {}, { coreActions = {}, coreCapabilities = new Set() } = {}) {
  const actionMap = new Map();
  for (const [name, def] of Object.entries(actions)) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(name)) throw new Error(`Host action "${name}": names are <domain>.<verb>`);
    if (typeof def?.handler !== 'function') throw new Error(`Host action "${name}": handler must be a function`);
    if (!def.capability || typeof def.capability !== 'string') throw new Error(`Host action "${name}": capability is required`);
    if (coreActions[name] && !def.override) throw new Error(`Host action "${name}" would replace a core action; set override: true to do that deliberately`);
    actionMap.set(name, { capability: def.capability, handler: def.handler, override: !!coreActions[name] });
  }

  const used = new Set([...coreCapabilities, ...Object.values(coreActions).map(a => a.capability).filter(Boolean)]);
  const policyMap = new Map();
  for (const [cap, p] of Object.entries(capabilities)) {
    if (used.has(cap)) throw new Error(`Host capability "${cap}" is core's; its policy can't be redefined by the host`);
    policyMap.set(cap, { min_rank: p?.min_rank ?? null, guest: !!p?.guest });
  }

  _actions = actionMap;
  _policy  = policyMap;
  return { actions: [...actionMap.keys()], overrides: [...actionMap].filter(([, d]) => d.override).map(([n]) => n) };
}

function get(name)    { return _actions.get(name) || null; }
function policy(cap)  { return _policy.get(cap) || null; }

// Core registry with host actions applied — for callers that look actions
// up by name themselves (ChainExecutor hooks).
function merged(coreActions) {
  return { ...coreActions, ...Object.fromEntries(_actions) };
}

function _reset() { _actions = new Map(); _policy = new Map(); }

module.exports = { register, get, policy, merged, _reset };
