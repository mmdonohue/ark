// SchemaReflector — reflects PostgreSQL column metadata per table and caches it.
// Requires migration 021 (ark_get_table_columns RPC function).
// Falls back to null (unfiltered writes) if the function isn't available.

const { supabase } = require('../services/supabase');

const TTL = 5 * 60 * 1000; // 5 minutes

class SchemaReflector {
  static _cache = new Map(); // table → { schema, loadedAt }

  // Returns a column map: { column_name: { data_type, is_nullable, column_default, ordinal_position } }
  // Returns null on failure (postgres adapter passes all fields through).
  static async get(table) {
    if (!table) return null;

    const cached = this._cache.get(table);
    if (cached && (Date.now() - cached.loadedAt) < TTL) {
      return cached.schema;
    }

    try {
      const { data, error } = await supabase.rpc('ark_get_table_columns', { p_table: table });

      if (error) {
        console.warn(`[SchemaReflector] ${table}: ${error.message}`);
        return null;
      }

      if (!data || data.length === 0) {
        console.warn(`[SchemaReflector] ${table}: no columns returned (table may not exist)`);
        return null;
      }

      const schema = {};
      for (const col of data) {
        schema[col.column_name] = {
          data_type:        col.data_type,
          is_nullable:      col.is_nullable,
          column_default:   col.column_default,
          ordinal_position: col.ordinal_position,
        };
      }

      this._cache.set(table, { schema, loadedAt: Date.now() });
      return schema;

    } catch (err) {
      console.warn(`[SchemaReflector] ${table}: fetch failed — ${err.message}`);
      return null;
    }
  }

  // Pre-warm the cache for a set of tables (call at bootstrap)
  static async prime(tables = []) {
    const results = await Promise.allSettled(tables.map(t => this.get(t)));
    const loaded  = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
    console.log(`  ✓ Schema primed (${loaded}/${tables.length} tables)`);
    return loaded;
  }

  static invalidate(table) {
    this._cache.delete(table);
  }

  static invalidateAll() {
    this._cache.clear();
  }

  // Returns a debug snapshot of what's currently cached
  static snapshot() {
    const out = {};
    for (const [table, entry] of this._cache.entries()) {
      out[table] = {
        columns:   Object.keys(entry.schema),
        loadedAt:  new Date(entry.loadedAt).toISOString(),
        expiresAt: new Date(entry.loadedAt + TTL).toISOString(),
      };
    }
    return out;
  }
}

module.exports = SchemaReflector;
