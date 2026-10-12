'use strict';

// register-pipeline.js — registers a pipeline recipe (pipeline.yaml) directly
// against the LIVE Supabase project, not the CLI's local SQLite vessel.
// `ark rescan` (ark/cli/ark.js) only writes to a local vessel DB — that's
// the media-import workflow's model (cache -> local Ark -> cloud Supabase
// via `ark publish`), not a fit for a pipeline the deployed web backend
// needs to resolve immediately via PipelineResolver.runPipeline.
//
// Usage:
//   node backend/ark/scripts/register-pipeline.js cinema-reel
//   node backend/ark/scripts/register-pipeline.js            # registers every pipelines/* directory

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const fs = require('fs');
const { supabase } = require('../services/supabase');
const { bootstrap } = require('../index');
const { registerDirectory, registerRecipes } = require('../core/PipelineRegistry');

const STORE_ID = 1; // Seravanna — the only tenant today, see routes/action.js

async function main() {
  await bootstrap({
    db:      { client: supabase },
    storage: { client: supabase, bucket: 'ark-media' },
  });

  const ctx = { store_id: STORE_ID, source: 'register-pipeline-script' };
  const slug = process.argv[2];
  const pipelinesDir = path.resolve(__dirname, '../pipelines');

  let results;
  if (slug) {
    results = [await registerDirectory(path.join(pipelinesDir, slug), ctx)];
  } else {
    const slugs = fs.readdirSync(pipelinesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(pipelinesDir, e.name, 'pipeline.yaml')))
      .map(e => e.name);
    results = await registerRecipes(slugs, ctx, pipelinesDir);
  }

  console.log(JSON.stringify({ ok: true, registered: results.map(r => r.pipeline.slug) }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exitCode = 1;
});
