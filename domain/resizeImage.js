'use strict';

// Resizes an image data_url to a max dimension at a fixed, non-aggressive
// JPEG quality — for "web friendly" display copies (Ark splash photos),
// never for anything that might end up as a catalog print source. Runs
// server-side via sharp rather than client-side canvas, for two reasons:
// (1) it's one code path instead of duplicated per upload component, and
// (2) it works uniformly after maybeTranscodeHeic has already turned a
// HEIC/HEIF buffer into JPEG — a client <canvas> can't decode HEIC at all
// (new Image().onload never fires for it), so client-side resize would
// silently hang on exactly the format an iPhone photo defaults to.

const sharp = require('sharp');

const DEFAULT_MAX_DIMENSION = 2000;
const DEFAULT_QUALITY = 85;

async function resizeDataUrl(dataUrl, { maxDimension = DEFAULT_MAX_DIMENSION, quality = DEFAULT_QUALITY } = {}) {
  const commaIdx = dataUrl.indexOf(',');
  const inputBuffer = Buffer.from(dataUrl.slice(commaIdx + 1), 'base64');

  const outputBuffer = await sharp(inputBuffer)
    .rotate() // apply EXIF orientation before resizing, then strip it
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();

  return `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;
}

module.exports = { resizeDataUrl, DEFAULT_MAX_DIMENSION, DEFAULT_QUALITY };
