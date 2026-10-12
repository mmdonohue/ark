'use strict';

// HEIC/HEIF → JPEG, for inline data_url media. iPhones default to HEIC
// ("High Efficiency") for photo capture; almost no browser can render it as
// an <img>, so anything captured straight from a phone (ArtifactEditor's
// photo upload) needs to land as JPEG regardless of what the camera wrote.
// Used both at write time (ArtifactActions.js addMedia) and by
// scripts/backfill_heic_media.js for rows already stored before this
// existed.

const convert = require('heic-convert');

const HEIC_MIME_RE = /^data:image\/hei[cf][^;]*;base64,/i;

function isHeicDataUrl(dataUrl) {
  return typeof dataUrl === 'string' && HEIC_MIME_RE.test(dataUrl);
}

// Returns the data_url unchanged if it isn't HEIC/HEIF. Otherwise decodes,
// converts to JPEG, and returns a new data:image/jpeg;base64,... string.
async function maybeTranscodeHeic(dataUrl) {
  if (!isHeicDataUrl(dataUrl)) return dataUrl;

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const inputBuffer = Buffer.from(base64, 'base64');

  const outputBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });

  return `data:image/jpeg;base64,${Buffer.from(outputBuffer).toString('base64')}`;
}

module.exports = { isHeicDataUrl, maybeTranscodeHeic };
