// CacheAdapter — in-memory Map with optional TTL.
// Drop-in replace with Redis adapter later by implementing the same interface.

class CacheAdapter {
  constructor(config = {}) {
    this.store = new Map();
    this.defaultTtl = config.ttl || 5 * 60 * 1000; // 5 min
  }

  async connect() {}

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlMs) {
    const expiresAt = ttlMs != null
      ? Date.now() + ttlMs
      : this.defaultTtl > 0 ? Date.now() + this.defaultTtl : null;
    this.store.set(key, { value, expiresAt });
    return true;
  }

  async del(key) {
    return this.store.delete(key);
  }

  async clear() {
    this.store.clear();
    return true;
  }

  size() { return this.store.size; }
}

module.exports = CacheAdapter;
