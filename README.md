# ARK

> ARK is a memory operating system in which immutable intent is resolved
> through contracts into governed execution, producing durable artifacts,
> provenance, and memory.

Read **[CHARTER.md](./CHARTER.md)** first — it's the authoritative
architecture reference (constitutional principles, runtime primitives,
pipeline/provider/executor model, and the addenda recording real
implementation decisions as they were made).

## Status

Extracted from `seravanna-site/backend/ark/` on 2026-10-12 as its own
base repo — Seravanna was always meant to be one tenant/vessel of a
general-purpose engine, not the engine itself (see CHARTER.md §1–§4).
The code is unchanged; only two things moved to make it stand alone:

- `services/supabase.js` — the one external dependency ark/ code reached
  outside its own tree for (`require('../../services/supabase')` in ~9
  files). Relocated here, require paths adjusted for the new depth, and
  its connection-check query swapped from Seravanna's `bookings` table to
  ark's own `artifacts` table.
- Local vessel instances (`arks/<name>/`) kept their small `ark.yaml`
  manifests but not their actual data (SQLite db + media cache) — that's
  per-vessel runtime state, not engine code. See `.gitignore`.

## Setup

```bash
npm install
cp .env.example .env   # fill in SUPABASE_URL/SUPABASE_KEY if you need
                        # anything beyond the local SQLite CLI vessel
node --test tests/unit.test.js
```

## Running it

The CLI (`cli/ark.js`) is the zero-network entry point — local SQLite
vessel by default, no Supabase project required:

```bash
node cli/ark.js dispatch artifact.create --payload '{"artifact_type":"note","title":"hello"}'
node cli/ark.js ls note
node cli/ark.js status
```

Everything else (storage, auth, llm, sync) is adapter configuration via
`Manifest` (see `core/bootstrap.js`) — a host app boots ARK the same way
`seravanna-site/backend/index.js` does:

```js
const { bootstrap } = require('./core/bootstrap');
const { supabase } = require('./services/supabase');

await bootstrap({
  db:      { client: supabase },
  storage: { client: supabase, bucket: 'ark-media' },
});
```
