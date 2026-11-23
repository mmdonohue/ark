'use strict';

// A project's repositories and workflows are unique by alias. The app checks
// that under a per-project lock (utils/keyedLock.js), which only covers one
// process; the database enforces it for everyone through a reserved slug —
// "<type>:<project_id>:<alias>" — and a partial unique index over active
// rows (sqlite: adapters/sqlite.js; Postgres: Seravanna migration 056).
// Retiring or removing sets inactive, which frees the alias.

const ALIAS_TYPES = ['repository', 'workflow'];

const aliasSlug = (type, projectId, alias) => `${type}:${projectId}:${alias}`;

// The insert lost a race the lock couldn't see (another process).
const isUniqueViolation = err => /UNIQUE constraint failed|duplicate key value|23505/.test(`${err?.code || ''} ${err?.message || ''}`);

module.exports = { ALIAS_TYPES, aliasSlug, isUniqueViolation };
