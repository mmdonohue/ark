'use strict';

// migrate-media-to-storage.js — one-off backfill for artifact_media rows
// that predate ArtifactActions.addMedia uploading to real storage (see
// backend/ark/domain/mediaStorage.js) and only ever got an inline data_url
// blob. Scope is the query itself, not a hardcoded id list: every row
// where data_url is set and url isn't. Re-running only ever touches
// whatever's still unmigrated (already-migrated rows have url set and drop
// out of the WHERE clause), so a partial failure is always safe to retry.
//
// Usage:
//   node backend/ark/scripts/migrate-media-to-storage.js            # dry run — lists rows, writes nothing
//   node backend/ark/scripts/migrate-media-to-storage.js --confirm  # uploads + updates rows

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const crypto = require('crypto');
const { supabase } = require('../services/supabase');
const { bootstrap, getManifest } = require('../index');
const { uploadImageBytes } = require('../domain/mediaStorage');

function mimeFromDataUrl(data_url) {
  const match = /^data:([^;,]+)[;,]/.exec(data_url);
  return match ? match[1] : null;
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  await bootstrap({
    db:      { client: supabase },
    storage: { client: supabase, bucket: 'ark-media' },
  });
  const storage = getManifest().get('storage');

  const { data: rows, error } = await supabase
    .from('artifact_media')
    .select('id, artifact_id, data_url, mime_type, content_hash')
    .not('data_url', 'is', null)
    .is('url', null);
  if (error) throw error;

  console.log(`${rows.length} row(s) to migrate${confirm ? '' : ' (dry run — pass --confirm to write)'}`);

  let migrated = 0;
  let failed = 0;

  for (const row of rows) {
    const bytes = Math.round((row.data_url.length - (row.data_url.indexOf(',') + 1)) * 0.75);
    const mime_type = row.mime_type || mimeFromDataUrl(row.data_url);
    const content_hash = row.content_hash || crypto.createHash('sha256')
      .update(Buffer.from(row.data_url.slice(row.data_url.indexOf(',') + 1), 'base64'))
      .digest('hex');

    console.log(`  ${row.id}  artifact:${row.artifact_id}  ${(bytes / 1024).toFixed(0)}KB  ${mime_type || '(no mime)'}`);
    if (!confirm) continue;

    try {
      const url = await uploadImageBytes(storage, { data_url: row.data_url, mime_type, content_hash });
      const { error: updateError } = await supabase
        .from('artifact_media')
        .update({ url, data_url: null, content_hash, mime_type })
        .eq('id', row.id);
      if (updateError) throw updateError;
      migrated++;
    } catch (err) {
      failed++;
      console.error(`    FAILED: ${err.message}`);
    }
  }

  console.log(confirm ? `Done — migrated ${migrated}, failed ${failed}` : 'Dry run complete — nothing written');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
