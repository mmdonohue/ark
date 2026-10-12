// PostgresAdapter — wraps the Supabase client for use by Packet.
// Phase 2: filters writes to known columns via SchemaReflector.
//   - Unknown fields are dropped with a console.warn (not an error)
//   - UPDATE scopes to store_id when the table has that column
//   - Falls back to unfiltered writes if schema is null

const SchemaReflector = require('../core/SchemaReflector');

class PostgresAdapter {
  constructor(supabaseClient) {
    this.client = supabaseClient;
  }

  async connect() { /* Supabase client connects lazily */ }

  // save({ table, idField, id, data, dirty, schema, context })
  async save({ table, idField = 'id', id, data, dirty = [], schema, context = {}, storeScoped = false }) {
    let clean = removeUndefined(data);

    // Filter to known columns when schema is available
    if (schema) {
      const unknown = Object.keys(clean).filter(k => !(k in schema));
      if (unknown.length > 0) {
        console.warn(`[postgres] ${table}: dropping unknown fields: ${unknown.join(', ')}`);
      }
      clean = Object.fromEntries(Object.entries(clean).filter(([k]) => k in schema));
    }

    if (id) {
      // UPDATE — prefer dirty fields; never re-write the PK
      const updateFields = dirty.length > 0
        ? Object.fromEntries(dirty.filter(k => k in clean).map(k => [k, clean[k]]))
        : { ...clean };

      delete updateFields[idField];

      let query = this.client.from(table).update(updateFields).eq(idField, id);

      // Always scope to store_id when the domain class marks itself as store-scoped.
      // Also applies when schema reflection confirms store_id exists (Phase 2+).
      if (context.store_id && (storeScoped || (schema && 'store_id' in schema))) {
        query = query.eq('store_id', context.store_id);
      }

      const { data: row, error } = await query.select().single();
      if (error) throw new Error(`[postgres] update ${table}: ${error.message}`);
      return row;

    } else {
      // INSERT
      const { data: row, error } = await this.client
        .from(table)
        .insert([clean])
        .select()
        .single();

      if (error) throw new Error(`[postgres] insert ${table}: ${error.message}`);
      return row;
    }
  }

  // delete({ table, idField, id, context })
  async delete({ table, idField = 'id', id, context = {}, storeScoped = false }) {
    const schema = await SchemaReflector.get(table);

    let query = this.client.from(table).delete().eq(idField, id);

    if (context.store_id && (storeScoped || (schema && 'store_id' in schema))) {
      query = query.eq('store_id', context.store_id);
    }

    const { error } = await query;
    if (error) throw new Error(`[postgres] delete ${table}: ${error.message}`);
    return true;
  }

  // Raw query escape hatch for complex operations
  get raw() { return this.client; }
}

function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

module.exports = PostgresAdapter;
