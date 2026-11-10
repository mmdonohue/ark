'use strict';

// host — the one seam between ARK and the application embedding it.
//
// ARK never requires a path outside its own tree. A host that hands ARK its
// own services (a db client, an LLM pool, a session store) exports them from
// ark.host.js at the package root — a function returning bootstrap() config,
// or the config itself. bootstrap() loads it, so every entry point (server,
// CLIs, scripts) gets the same services and none can forget one. Explicit
// bootstrap() config wins over the host's, key by key. No file: plain env
// defaults, which is how standalone ARK runs.

const fs   = require('fs');
const path = require('path');

const HOST_FILE = path.resolve(__dirname, '../ark.host.js');

function loadHost(file = HOST_FILE) {
  if (!fs.existsSync(file)) return {};
  const mod = require(file);
  const config = typeof mod === 'function' ? mod() : mod;
  return config && typeof config === 'object' ? config : {};
}

const isPlain = v => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// One level deep: { llm: { pool } } from the host and { llm: { model } } from
// the caller combine; a client object is replaced, never merged into.
function mergeConfig(host = {}, explicit = {}) {
  const out = { ...host };
  for (const [k, v] of Object.entries(explicit)) {
    out[k] = isPlain(v) && isPlain(host[k]) ? { ...host[k], ...v } : v;
  }
  return out;
}

module.exports = { loadHost, mergeConfig, HOST_FILE };
