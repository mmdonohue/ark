// SqliteAdapter — local, file-backed db adapter for running ARK without Supabase.
// Implements the same save()/delete()/raw contract as PostgresAdapter so Packet
// and every domain class work unmodified against either backend.
//
// `raw` exposes a small subset of the Supabase/PostgREST chain API — only the
// methods actually used across domain/actions/core (see grep inventory in the
// ARK charter addendum). Postgres-only features (embedded relation selects,
// `.or()`, `.overlaps()`, JSON-path `.filter()`) fail loudly with a clear
// "not supported in local sqlite mode" error instead of silently misbehaving.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// Columns stored as JSON-encoded TEXT (Postgres jsonb / array columns).
const JSON_COLUMNS = {
  artifacts:            ['metadata', 'context', 'tag_keys'],
  artifact_media:        ['metadata'],
  artifact_relations:    ['metadata'],
  artifact_chains:       ['context', 'error'],
  artifact_chain_steps:  ['input', 'result', 'error'],
  artifact_ledger:       ['canonical_payload', 'resolved_contract', 'execution_trace', 'provenance', 'error'],
};

// Columns stored as INTEGER 0/1 (Postgres boolean).
const BOOLEAN_COLUMNS = {
  artifacts:  ['inactive'],
  ark_actors: ['inactive'],
};

class SqliteAdapter {
  constructor(dbPath = './ark/ark.sqlite') {
    this.dbPath = dbPath;
    this.db     = null;
  }

  async connect() {
    // better-sqlite3 does not create the parent directory — a first-ever run
    // on a vessel whose directory doesn't exist yet (or one that was deleted
    // to reset) would otherwise fail here, and Manifest.load() swallows
    // connect() errors into a warning, leaving this.db null and every
    // subsequent query crashing on "Cannot read properties of null."
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._ensureSchema();
  }

  _ensureSchema() {
    const ddl = fs.readFileSync(path.resolve(__dirname, './sqlite.schema.sql'), 'utf8');
    this.db.exec(ddl);
    this._schemaCache = new Map();
  }

  // Column filtering must never depend on the real Postgres project's
  // schema — SchemaReflector (used by Packet.schema()) always queries the
  // remote project regardless of which db adapter is active, so a column
  // added locally but not yet migrated to Postgres (or vice versa) would
  // otherwise get silently dropped on every local write. SQLite introspects
  // itself instead, via PRAGMA table_info — the passed-in `schema` argument
  // (Postgres-derived) is intentionally ignored in save().
  _localSchema(table) {
    if (this._schemaCache.has(table)) return this._schemaCache.get(table);
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    const schema = Object.fromEntries(cols.map(c => [c.name, true]));
    this._schemaCache.set(table, schema);
    return schema;
  }

  // ── Encoding helpers ──────────────────────────────────────────────────────

  _encodeRow(table, data) {
    const jsonCols = JSON_COLUMNS[table]    || [];
    const boolCols = BOOLEAN_COLUMNS[table] || [];
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (jsonCols.includes(k))      out[k] = JSON.stringify(v ?? null);
      else if (boolCols.includes(k)) out[k] = v ? 1 : 0;
      else                            out[k] = v;
    }
    return out;
  }

  _decodeRow(table, row) {
    if (!row) return row;
    const jsonCols = JSON_COLUMNS[table]    || [];
    const boolCols = BOOLEAN_COLUMNS[table] || [];
    const out = { ...row };
    for (const k of jsonCols) {
      if (out[k] !== undefined && out[k] !== null) {
        try { out[k] = JSON.parse(out[k]); } catch { /* leave as string */ }
      }
    }
    for (const k of boolCols) {
      if (out[k] !== undefined && out[k] !== null) out[k] = !!out[k];
    }
    return out;
  }

  // ── Governed write path — mirrors PostgresAdapter exactly ───────────────────

  async save({ table, idField = 'id', id, data, dirty = [], schema: _ignoredRemoteSchema, context = {}, storeScoped = false }) {
    let clean = removeUndefined(data);

    const schema = this._localSchema(table);
    if (schema) {
      const unknown = Object.keys(clean).filter(k => !(k in schema));
      if (unknown.length > 0) {
        console.warn(`[sqlite] ${table}: dropping unknown fields: ${unknown.join(', ')}`);
      }
      clean = Object.fromEntries(Object.entries(clean).filter(([k]) => k in schema));
    }

    if (id) {
      const updateFields = dirty.length > 0
        ? Object.fromEntries(dirty.filter(k => k in clean).map(k => [k, clean[k]]))
        : { ...clean };
      delete updateFields[idField];

      if (Object.keys(updateFields).length === 0) {
        return this._selectOne(table, idField, id);
      }

      const encoded = this._encodeRow(table, updateFields);
      const setClause = Object.keys(encoded).map(k => `"${k}" = @${k}`).join(', ');
      let sql = `UPDATE ${table} SET ${setClause} WHERE "${idField}" = @__id`;
      const params = { ...encoded, __id: id };

      if (context.store_id && storeScoped) {
        sql += ` AND "store_id" = @__store_id`;
        params.__store_id = context.store_id;
      }

      const info = this.db.prepare(sql).run(params);
      if (info.changes === 0) throw new Error(`[sqlite] update ${table}: no row matched id=${id}`);
      return this._selectOne(table, idField, id);

    } else {
      const withId  = { [idField]: clean[idField] || crypto.randomUUID(), ...clean };
      const encoded = this._encodeRow(table, withId);
      const cols    = Object.keys(encoded);
      const sql = `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`;

      try {
        this.db.prepare(sql).run(encoded);
      } catch (err) {
        throw new Error(`[sqlite] insert ${table}: ${err.message}`);
      }
      return this._selectOne(table, idField, encoded[idField]);
    }
  }

  _selectOne(table, idField, id) {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE "${idField}" = ?`).get(id);
    return this._decodeRow(table, row);
  }

  async delete({ table, idField = 'id', id, context = {}, storeScoped = false }) {
    let sql = `DELETE FROM ${table} WHERE "${idField}" = @__id`;
    const params = { __id: id };
    if (context.store_id && storeScoped) {
      sql += ` AND "store_id" = @__store_id`;
      params.__store_id = context.store_id;
    }
    this.db.prepare(sql).run(params);
    return true;
  }

  // Raw query escape hatch — a bounded subset of the Supabase/PostgREST chain API.
  get raw() {
    return { from: (table) => new SqliteQueryBuilder(this.db, this, table) };
  }
}

// ── Query builder ────────────────────────────────────────────────────────────
// Thenable, chainable, mirrors the shape of a Supabase PostgrestFilterBuilder
// closely enough for the call sites that actually exist in domain/actions/core.

class SqliteQueryBuilder {
  constructor(db, adapter, table) {
    this.db          = db;
    this.adapter     = adapter;
    this.table       = table;
    this.action      = 'select'; // 'select' | 'update' | 'delete'
    this.selectCols  = '*';
    this.conditions  = [];       // [{ type, col, val }]
    this.orderBy     = null;
    this.limitN      = null;
    this.updateFields = null;
    this.wantSingle      = false;
    this.wantMaybeSingle = false;
    this._unsupported    = null;
  }

  select(cols = '*') {
    // Support exactly one embed pattern: "table!fkcol(*)" — a foreign-key
    // embed, e.g. artifacts!target_artifact_id(*). Used by ark.get / workflow.get
    // to pull the related artifact row alongside a relation row. Anything more
    // exotic (nested embeds, column lists inside the embed) is rejected loudly.
    const embedMatch = cols.match(/(\w+)!(\w+)\(([^)]*)\)/);
    if (embedMatch) {
      const [, embedTable, fkCol, embedCols] = embedMatch;
      if (embedCols.trim() !== '*') {
        this._unsupported = `embedded relation select with column list ("${cols}") is not supported in local sqlite mode — only "table!fkcol(*)" is`;
      } else {
        this.embed = { table: embedTable, fkCol };
      }
    }
    this.selectCols = cols.replace(/\s*,?\s*\w+!\w+\([^)]*\)\s*,?/, '').trim();
    if (!this.selectCols) this.selectCols = '*';
    return this;
  }

  eq(col, val)     { this.conditions.push({ type: 'eq',   col, val }); return this; }
  in(col, vals)    { this.conditions.push({ type: 'in',   col, val: vals }); return this; }
  like(col, val)   { this.conditions.push({ type: 'like', col, val }); return this; }
  lt(col, val)     { this.conditions.push({ type: 'lt',   col, val }); return this; }
  gt(col, val)     { this.conditions.push({ type: 'gt',   col, val }); return this; }
  lte(col, val)    { this.conditions.push({ type: 'lte',  col, val }); return this; }
  gte(col, val)    { this.conditions.push({ type: 'gte',  col, val }); return this; }
  order(col, { ascending = true } = {}) { this.orderBy = { col, ascending }; return this; }
  limit(n)         { this.limitN = n; return this; }
  single()         { this.wantSingle = true; return this; }
  maybeSingle()    { this.wantMaybeSingle = true; return this; }

  update(fields) { this.action = 'update'; this.updateFields = fields; return this; }
  delete()       { this.action = 'delete'; return this; }

  filter(col, op, val) {
    if (col.includes('->')) {
      this._unsupported = `JSON path filter ("${col}") is not supported in local sqlite mode`;
      return this;
    }
    const OPS = { eq: 'eq', neq: 'neq', gt: 'gt', lt: 'lt', gte: 'gte', lte: 'lte' };
    if (!OPS[op]) {
      this._unsupported = `filter operator "${op}" is not supported in local sqlite mode`;
      return this;
    }
    this.conditions.push({ type: OPS[op], col, val });
    return this;
  }

  or()       { this._unsupported = '.or() is not supported in local sqlite mode';       return this; }
  overlaps() { this._unsupported = '.overlaps() is not supported in local sqlite mode';  return this; }

  // ── Execution ───────────────────────────────────────────────────────────

  _buildWhere() {
    if (!this.conditions.length) return { sql: '', params: {} };
    const CMP = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
    const parts  = [];
    const params = {};
    let n = 0;

    for (const c of this.conditions) {
      const col = `"${c.col}"`;
      if (c.type === 'in') {
        const keys = c.val.map(() => `@w${n++}`);
        c.val.forEach((v, i) => { params[keys[i].slice(1)] = _scalar(v); });
        parts.push(`${col} IN (${keys.join(', ')})`);
      } else if (c.type === 'like') {
        const key = `w${n++}`;
        params[key] = c.val;
        parts.push(`${col} LIKE @${key}`);
      } else {
        const key = `w${n++}`;
        params[key] = _scalar(c.val);
        parts.push(`${col} ${CMP[c.type]} @${key}`);
      }
    }
    return { sql: 'WHERE ' + parts.join(' AND '), params };
  }

  async _run() {
    if (this._unsupported) return { data: null, error: { message: this._unsupported } };
    try {
      if (this.action === 'update') return this._runUpdate();
      if (this.action === 'delete') return this._runDelete();
      return this._runSelect();
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  _runSelect() {
    const { sql: whereSql, params } = this._buildWhere();
    let colList = this.selectCols === '*' ? null : this.selectCols.split(',').map(c => c.trim());

    // The embed's fk column must be present in the result even if the caller
    // didn't explicitly list it, so we can look up the embedded row per-row.
    if (this.embed && colList && !colList.includes(this.embed.fkCol)) {
      colList = [...colList, this.embed.fkCol];
    }
    const cols = colList ? colList.map(c => `"${c}"`).join(', ') : '*';

    let sql = `SELECT ${cols} FROM ${this.table} ${whereSql}`;
    if (this.orderBy) sql += ` ORDER BY "${this.orderBy.col}" ${this.orderBy.ascending ? 'ASC' : 'DESC'}`;
    if (this.limitN != null) sql += ` LIMIT ${Number(this.limitN)}`;

    let rows = this.db.prepare(sql).all(params).map(r => this.adapter._decodeRow(this.table, r));

    if (this.embed) {
      const { table: embedTable, fkCol } = this.embed;
      const stmt = this.db.prepare(`SELECT * FROM ${embedTable} WHERE "id" = ?`);
      rows = rows.map(row => ({
        ...row,
        [embedTable]: row[fkCol] != null
          ? this.adapter._decodeRow(embedTable, stmt.get(row[fkCol])) || null
          : null,
      }));
    }

    if (this.wantSingle) {
      if (rows.length !== 1) {
        return { data: null, error: { message: `Expected exactly one row, got ${rows.length}`, code: 'PGRST116' } };
      }
      return { data: rows[0], error: null };
    }
    if (this.wantMaybeSingle) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  _runUpdate() {
    const { sql: whereSql, params: whereParams } = this._buildWhere();
    const encoded = this.adapter._encodeRow(this.table, removeUndefined(this.updateFields));
    const setParams = {};
    const setParts = Object.keys(encoded).map(k => {
      setParams[`s_${k}`] = encoded[k];
      return `"${k}" = @s_${k}`;
    });
    const sql = `UPDATE ${this.table} SET ${setParts.join(', ')} ${whereSql}`;
    this.db.prepare(sql).run({ ...setParams, ...whereParams });
    return { data: null, error: null };
  }

  _runDelete() {
    const { sql: whereSql, params } = this._buildWhere();
    this.db.prepare(`DELETE FROM ${this.table} ${whereSql}`).run(params);
    return { data: null, error: null };
  }

  then(resolve, reject) { return this._run().then(resolve, reject); }
}

function _scalar(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function removeUndefined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

module.exports = SqliteAdapter;
