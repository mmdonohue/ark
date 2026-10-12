'use strict';

// Shared upload helper — used by ArtifactActions.addMedia (new uploads) and
// ark/scripts/migrate-media-to-storage.js (the one-off backfill of
// artifact_media rows that predate this and only ever got a data_url).

function extensionForMime(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  return map[mime] || '.jpg'; // photos dominate this system; addMedia always transcodes HEIC->jpeg first anyway
}

// Content-addressed filename (the sha256 this system already computes for
// dedup) — two artifacts referencing identical bytes collapse to one
// storage object for free, and re-running the migration script is
// naturally idempotent (same hash, same path, upsert:true).
async function uploadImageBytes(storage, { data_url, mime_type, content_hash }) {
  const buffer = Buffer.from(data_url.slice(data_url.indexOf(',') + 1), 'base64');
  const filename = `${content_hash}${extensionForMime(mime_type)}`;
  const { url } = await storage.upload({
    file: { buffer, filename, contentType: mime_type || 'image/jpeg' },
    folder: 'artifact-media',
  });
  return url;
}

module.exports = { uploadImageBytes, extensionForMime };
