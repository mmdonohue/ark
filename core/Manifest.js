// Manifest — service registry. Loaded once at startup, shared across all Packets.
// Adapters register themselves here. Packet.configure(manifest) wires it in.

const PostgresAdapter  = require('../adapters/postgres');
const SqliteAdapter    = require('../adapters/sqlite');
const StorageAdapter   = require('../adapters/storage');
const AuthAdapter      = require('../adapters/auth');
const CacheAdapter     = require('../adapters/cache');
const LoggerAdapter    = require('../adapters/logger');
const TracerAdapter    = require('../adapters/tracer');
const MetricsAdapter   = require('../adapters/metrics');
const ServicesAdapter  = require('../adapters/services');
const LLMAdapter       = require('../adapters/llm');

class Manifest {
  constructor(config = {}) {
    this.config   = config;
    this.services = new Map();
  }

  async load() {
    // db adapter: sqlite for local/CLI mode, Postgres (Supabase) otherwise.
    // Postgres mode requires an injected client — ark/ doesn't reach outside
    // its own tree for credentials. The host app (backend/index.js) or a
    // documented exception (cli/ark-dev.js) supplies config.db.client.
    if (this.config.db?.driver === 'sqlite') {
      this.register('db', new SqliteAdapter(this.config.db.path));
    } else {
      if (!this.config.db?.client) {
        throw new Error('Manifest: postgres mode requires config.db.client (an injected Supabase/Postgres client)');
      }
      this.register('db', new PostgresAdapter(this.config.db.client));
    }

    this.register('storage',  new StorageAdapter(this.config.storage  || {}));
    this.register('auth',     new AuthAdapter(this.config.auth        || {}));
    this.register('cache',    new CacheAdapter(this.config.cache      || {}));
    this.register('logger',   new LoggerAdapter(this.config.logging   || {}));
    this.register('trace',    new TracerAdapter(this.config.tracing   || {}));
    this.register('metrics',  new MetricsAdapter(this.config.metrics  || {}));
    this.register('services', new ServicesAdapter(this.config.services || {}, this));
    this.register('llm',      new LLMAdapter(this.config.llm         || {}));

    // Connect all adapters that have a connect() method
    await Promise.all(
      [...this.services.values()]
        .filter(s => typeof s.connect === 'function')
        .map(s => s.connect().catch(err => {
          console.error(`  ✗ Manifest adapter failed: ${err.message}`);
        }))
    );

    return this;
  }

  register(name, service, { override = false } = {}) {
    if (this.services.has(name) && !override) {
      throw new Error(`Manifest: service already registered: ${name}`);
    }
    this.services.set(name, service);
    return this;
  }

  get(name) {
    const svc = this.services.get(name);
    if (!svc) throw new Error(`Manifest: service not registered: ${name}`);
    return svc;
  }

  has(name)   { return this.services.has(name); }
  export()    { return Object.fromEntries(this.services); }
  list()      { return [...this.services.keys()]; }
}

module.exports = Manifest;
