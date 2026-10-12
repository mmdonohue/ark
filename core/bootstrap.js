// bootstrap — initializes the Manifest singleton and configures Packet.
// Call once at server startup. Subsequent calls return the cached instance.

const Manifest          = require('./Manifest');
const Packet            = require('./Packet');
const SchemaReflector   = require('./SchemaReflector');
const TemplateResolver  = require('./TemplateResolver');

// The governing design doc for this runtime — backend/ark/CHARTER.md.
// Its real version lives in the graph (artifact_type: 'charter', see
// ark-dev.js's _ensureCharter — content-hash versioned, supersedes chain),
// not here — this is just an identity label, not a version number to keep
// in sync by hand.
const CHARTER_VERSION = 'ARK Architecture Charter';

// Tables that get schema-primed at startup so the first request is never a cache miss
const PRIME_TABLES = [
  'artifacts',
  'artifact_media',
  'artifact_relations',
  'artifact_chains',
  'artifact_chain_steps',
  'artifact_ledger',
  'ark_actors',
];

let _manifest = null;

async function bootstrap(config = {}) {
  if (_manifest) return _manifest;
  _manifest = await new Manifest(config).load();
  Packet.configure(_manifest);

  console.log(`  ✓ ${CHARTER_VERSION}`);

  // Prime schema cache for core tables (non-blocking — failures are warnings)
  SchemaReflector.prime(PRIME_TABLES).catch(() => {});

  // TemplateResolver: no templates to prime at startup yet — priming happens
  // when specific template slugs are known (e.g., after seeding domain data).
  // Expose on manifest for debug/admin access.
  _manifest.register('templates', TemplateResolver);
  _manifest.register('charter_version', CHARTER_VERSION);

  return _manifest;
}

function getManifest() {
  if (!_manifest) throw new Error('[ARK] Manifest not initialized. Call bootstrap() at startup.');
  return _manifest;
}

// Reset for testing
function _reset() { _manifest = null; }

module.exports = { bootstrap, getManifest, _reset };
