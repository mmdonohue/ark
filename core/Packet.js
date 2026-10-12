// Packet — universal execution unit. Every operation in the system is a Packet.
// Domain classes extend this and define only static table (and optionally static id).

const SchemaReflector = require('./SchemaReflector');

class Packet {
  static manifest     = null;
  static table        = null;
  static id           = 'id';
  static storeScoped  = false; // set true on domain classes whose table has a store_id column

  // Called once at startup: Packet.configure(manifest)
  static configure(manifest) {
    if (!manifest) throw new Error('Packet.configure requires a manifest');
    Packet.manifest = manifest;
  }

  static service(name) {
    if (!Packet.manifest) throw new Error('Packet manifest not configured. Call Packet.configure(manifest) at startup.');
    return Packet.manifest.get(name);
  }

  constructor(data = {}, options = {}) {
    if (!this.constructor.table) {
      throw new Error(`${this.constructor.name} must define static table`);
    }

    this.data     = { ...data };
    this.original = { ...data };
    this.dirty    = new Set();

    this.context = options.context || {};
    this.meta = {
      request_id: options.request_id || this.context.request_id || null,
      trace_id:   options.trace_id   || this.context.trace_id   || null,
      runtime_id: options.runtime_id || this.context.runtime_id || null,
      source:     options.source     || this.context.source     || 'system',
    };
  }

  // ── Service accessors ──────────────────────────────────────────────────────

  service(name)  { return this.constructor.service(name); }

  // Static raw DB access — use for complex reads that don't go through save/delete
  static get db() { return Packet.service('db').raw; }

  get db()       { return this.service('db'); }
  get storage()  { return this.service('storage'); }
  get auth()     { return this.service('auth'); }
  get cache()    { return this.service('cache'); }
  get logger()   { return this.service('logger'); }
  get tracer()   { return this.service('trace'); }
  get metrics()  { return this.service('metrics'); }
  get services() { return this.service('services'); }

  // ── Identity ───────────────────────────────────────────────────────────────

  get table()   { return this.constructor.table; }
  get idField() { return this.constructor.id || 'id'; }
  get id()      { return this.data[this.idField] ?? null; }

  // ── Data access ────────────────────────────────────────────────────────────

  get(key, fallback = null) {
    return this.data[key] !== undefined ? this.data[key] : fallback;
  }

  set(key, value) {
    if (this.data[key] !== value) {
      this.data[key] = value;
      this.dirty.add(key);
    }
    return this;
  }

  assign(values = {}) {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
    return this;
  }

  isDirty(key) { return key ? this.dirty.has(key) : this.dirty.size > 0; }

  // ── Lifecycle hooks (override in domain classes) ───────────────────────────

  async prepare() {}    // runs before save — inject defaults, context fields
  async afterSave() {}  // runs after successful save

  // ── Persistence ────────────────────────────────────────────────────────────

  async schema() {
    return SchemaReflector.get(this.table); // null in Phase 1; populated in Phase 2
  }

  async authorize(action) {
    return this.auth.authorize({ action, packet: this, context: this.context });
  }

  async save() {
    return this.trace('save', async () => {
      await this.prepare();
      await this.authorize(`${this.constructor.name}.save`);

      const schema = await this.schema();

      const record = await this.db.save({
        table:        this.table,
        idField:      this.idField,
        id:           this.id,
        data:         { ...this.data },
        dirty:        [...this.dirty],
        schema,
        context:      this.context,
        storeScoped:  this.constructor.storeScoped,
      });

      this.data     = { ...record };
      this.original = { ...record };
      this.dirty.clear();

      await this.afterSave();
      return this;
    });
  }

  async delete() {
    return this.trace('delete', async () => {
      await this.authorize(`${this.constructor.name}.delete`);

      if (!this.id) throw new Error(`Cannot delete unsaved ${this.constructor.name}`);

      await this.db.delete({
        table:       this.table,
        idField:     this.idField,
        id:          this.id,
        context:     this.context,
        storeScoped: this.constructor.storeScoped,
      });

      return true;
    });
  }

  async upload(file, options = {}) {
    return this.storage.upload({ file, packet: this, context: this.context, ...options });
  }

  async call(service, method, payload = {}) {
    return this.services.call({ service, method, payload, packet: this, context: this.context });
  }

  // ── Tracing ────────────────────────────────────────────────────────────────

  async trace(operation, callback) {
    return this.tracer.run(
      `${this.constructor.name}.${operation}`,
      {
        table:      this.table,
        id:         this.id,
        request_id: this.meta.request_id,
        trace_id:   this.meta.trace_id,
        user_id:    this.context.user_id,
        store_id:   this.context.store_id,
      },
      callback,
    );
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  toJSON() { return { ...this.data }; }

  toString() { return `[${this.constructor.name}:${this.id ?? 'new'}]`; }
}

module.exports = Packet;
