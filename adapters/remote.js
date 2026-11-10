'use strict';

// RemoteAdapter — the cloud Supabase project. Registered in Manifest as
// 'remote'. sync.push publishes to it, and Postgres mode uses it as the db
// client when none is passed in. Kept apart from 'db' because a local sqlite
// vessel still pushes to the cloud.
//
// Resolved on first use, never at load: a local-only vessel must be able to
// load every action without cloud credentials. Source, in order:
//   config.client  — a client, or a function returning one (ark.host.js)
//   fallback       — the db client, in Postgres mode
//   SUPABASE_URL / SUPABASE_KEY (from the environment, or ARK's own .env)

const path = require('path');

class RemoteAdapter {
  constructor(config = {}, fallback = null) {
    this.config   = config;
    this.fallback = fallback;
    this._client  = null;
  }

  get client() {
    if (!this._client) {
      const c = this.config.client;
      this._client = (typeof c === 'function' ? c() : c) || this.fallback || this._fromEnv();
    }
    return this._client;
  }

  _fromEnv() {
    if (!process.env.SUPABASE_URL) require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
    const { SUPABASE_URL: url, SUPABASE_KEY: key } = process.env;
    if (!url || !key) {
      throw Object.assign(new Error('No remote configured: set SUPABASE_URL and SUPABASE_KEY, or provide remote.client in ark.host.js'), { code: 'REMOTE_NOT_CONFIGURED' });
    }
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key);
  }
}

module.exports = RemoteAdapter;
