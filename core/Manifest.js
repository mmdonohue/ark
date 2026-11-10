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
const HarnessAdapter   = require('../adapters/harness');
const RemoteAdapter    = require('../adapters/remote');

class Manifest {
  constructor(config = {}) {
    this.config   = config;
    this.services = new Map();
  }

  async load() {
    // db adapter: sqlite for local/CLI mode, Postgres (Supabase) otherwise.
    // Postgres mode takes config.db.client, else the remote client (the
    // host's, or one built from SUPABASE_* env) — see adapters/remote.js.
    const remote = new RemoteAdapter(this.config.remote || {}, this.config.db?.client || null);
    if (this.config.db?.driver === 'sqlite') {
      this.register('db', new SqliteAdapter(this.config.db.path));
    } else {
      let client;
      try { client = remote.client; } catch (err) {
        throw new Error(`Manifest: postgres mode needs a client — config.db.client, remote.client in ark.host.js, or SUPABASE_URL/SUPABASE_KEY (${err.message})`);
      }
      this.register('db', new PostgresAdapter(client));
    }
    this.register('remote', remote);

    this.register('storage',  new StorageAdapter(this.config.storage  || {}));
    this.register('auth',     new AuthAdapter(this.config.auth        || {}));
    this.register('cache',    new CacheAdapter(this.config.cache      || {}));
    this.register('logger',   new LoggerAdapter(this.config.logging   || {}));
    this.register('trace',    new TracerAdapter(this.config.tracing   || {}));
    this.register('metrics',  new MetricsAdapter(this.config.metrics  || {}));
    this.register('services', new ServicesAdapter(this.config.services || {}, this));
    this.register('llm',      new LLMAdapter(this.config.llm         || {}));
    this.register('harness',  new HarnessAdapter(this.config.harness || {}));

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
