-- Local SQLite schema for the ARK core tables — translated from the live
-- Supabase/Postgres schema (see SchemaReflector.get() dump used to generate this).
-- Scope: PRIME_TABLES from core/bootstrap.js — the tables the governed runtime
-- (Packet/Artifact/ChainExecutor/Ledger) actually writes through.
--
-- jsonb/array columns are stored as TEXT (JSON-encoded) — see JSON_COLUMNS in
-- services/adapters/sqlite.js. boolean columns are stored as INTEGER 0/1.
-- uuid columns are TEXT; ids are generated app-side (crypto.randomUUID()),
-- not by a DB default, since SQLite has no gen_random_uuid().

CREATE TABLE IF NOT EXISTS artifacts (
  id             TEXT PRIMARY KEY,
  site_id        TEXT,
  store_id       INTEGER,
  artifact_type  TEXT,
  title          TEXT,
  slug           TEXT,
  summary        TEXT,
  body           TEXT,
  status         TEXT DEFAULT 'draft',
  metadata       TEXT DEFAULT '{}',
  context        TEXT DEFAULT '{}',
  tag_keys       TEXT DEFAULT '[]',
  owner_id       INTEGER,
  created_by     INTEGER,
  updated_by     INTEGER,
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at   TEXT,
  inactive       INTEGER DEFAULT 0,
  domain_id      TEXT,
  template_id    TEXT,
  content_hash   TEXT
);

CREATE TABLE IF NOT EXISTS artifact_media (
  id                TEXT PRIMARY KEY,
  artifact_id       TEXT,
  media_type        TEXT,
  provider          TEXT,
  url               TEXT,
  thumbnail_url     TEXT,
  title             TEXT,
  caption           TEXT,
  alt               TEXT,
  mime_type         TEXT,
  file_size         INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration_seconds  INTEGER,
  sort_order        INTEGER DEFAULT 0,
  metadata          TEXT DEFAULT '{}',
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status            TEXT DEFAULT 'active',
  updated_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  data_url          TEXT,
  content_hash      TEXT
);

CREATE TABLE IF NOT EXISTS artifact_relations (
  id                   TEXT PRIMARY KEY,
  source_artifact_id   TEXT,
  target_artifact_id   TEXT,
  relation_type        TEXT,
  order_index          INTEGER,
  metadata             TEXT DEFAULT '{}',
  created_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS artifact_chains (
  id            TEXT PRIMARY KEY,
  store_id      TEXT,
  principal_id  TEXT,
  action        TEXT,
  status        TEXT DEFAULT 'pending',
  context       TEXT DEFAULT '{}',
  error         TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at    TEXT,
  completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS artifact_chain_steps (
  id            TEXT PRIMARY KEY,
  chain_id      TEXT,
  step_index    INTEGER,
  action        TEXT,
  status        TEXT DEFAULT 'pending',
  input         TEXT DEFAULT '{}',
  result        TEXT,
  error         TEXT,
  started_at    TEXT,
  completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS artifact_ledger (
  id                  TEXT PRIMARY KEY,
  store_id            INTEGER,
  actor_id            INTEGER,
  action              TEXT,
  contract_id         TEXT,
  canonical_payload   TEXT DEFAULT '{}',
  resolved_contract   TEXT DEFAULT '{}',
  execution_trace     TEXT DEFAULT '[]',
  chain_id            TEXT,
  resolution          TEXT,
  error               TEXT,
  provenance          TEXT DEFAULT '{}',
  status              TEXT DEFAULT 'open',
  opened_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at           TEXT,
  duration_ms         INTEGER
);

-- ark_actors: ARK's own notion of "who" — independent of Seravanna's users
-- table. Roles and vessels/stores are NOT separate tables — they're
-- artifacts (artifact_type: 'role', artifact_type: 'store'). Mirrors
-- migrations/027_ark_actors.sql (the Postgres/Supabase counterpart).
CREATE TABLE IF NOT EXISTS ark_actors (
  id            TEXT PRIMARY KEY,
  store_id      INTEGER,
  role_id       TEXT,
  display_name  TEXT,
  email         TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  inactive      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_artifacts_store          ON artifacts(store_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type            ON artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifact_media_artifact    ON artifact_media(artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_media_hash         ON artifact_media(content_hash);
CREATE INDEX IF NOT EXISTS idx_artifact_relations_source  ON artifact_relations(source_artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_relations_target  ON artifact_relations(target_artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_chain_steps_chain ON artifact_chain_steps(chain_id);
CREATE INDEX IF NOT EXISTS idx_artifact_ledger_store      ON artifact_ledger(store_id);
CREATE INDEX IF NOT EXISTS idx_ark_actors_store            ON ark_actors(store_id);
CREATE INDEX IF NOT EXISTS idx_ark_actors_role              ON ark_actors(role_id);
