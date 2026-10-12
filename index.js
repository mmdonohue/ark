'use strict';

// Public entry point for the ark/ package. Everything Seravanna's own
// backend needs from ARK — HTTP bridge (routes/action.js), startup
// (index.js) — comes through here, not by reaching into ark/'s internals
// directly. See ark/arks/*/ark.yaml for what "self-contained" buys: this
// package has no require() pointing outside its own tree except where an
// ark instance is explicitly documented as non-portable (cli/ark-dev.js).

const { bootstrap, getManifest } = require('./core/bootstrap');
const { dispatch, ACTION_REGISTRY, PCER_REGISTRY, _shapeEgress, _assertCapability } = require('./core/dispatch');
const ChainExecutor = require('./core/ChainExecutor');

module.exports = {
  bootstrap,
  getManifest,
  dispatch,
  ACTION_REGISTRY,
  PCER_REGISTRY,
  _shapeEgress,
  _assertCapability,
  ChainExecutor,
};
