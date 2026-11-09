'use strict';

// SVG uploads are kept as vector instead of going through sharp (which would
// flatten them to a JPEG: no crisp scaling, transparency turned black), so
// addMedia sanitizes them here first.
//
// Why sanitize at all when every renderer uses <img> (which never runs SVG
// script): the stored file has its own public URL, and opening that URL directly
// renders the SVG as a document, scripts and event handlers included. Stripped
// before storage: <script>, event-handler attributes, <foreignObject> (HTML
// inside SVG), <style> and style="" entirely, and every external reference. An
// href must be an in-document #fragment or an inline data:image. CSS is dropped
// rather than filtered because a text filter can't keep up with what browsers
// decode (escapes like u\72l(), comments, image-set() with bare strings).
// Presentation attributes (fill, stroke, ...) are still CSS values, so one
// carrying an escape, a comment or image-set() is dropped, and any url() that
// isn't local is neutralized. A directly-opened SVG can't fetch arbitrary URLs.
// Cost: artwork colored only through an embedded <style> block loses those
// colors; exporting with presentation attributes keeps them.

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');
const { imageSize } = require('image-size');

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SVG_BYTES = 2 * 1024 * 1024; // vector art this large is almost always an embedded bitmap

const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);

const INLINE_BITMAP = /^data:image\/(png|jpe?g|gif|webp);base64,/i;
const isLocalRef = (value) => value.startsWith('#') || INLINE_BITMAP.test(value);

// Anything a CSS-value text filter can't reliably see through: escapes,
// comments, at-rules, and functions that load a URL from a bare string.
const UNSAFE_CSS_VALUE = /\\|\/\*|@|image-set|image\(|cross-fade|element\(/i;

// Neutralize any url() that isn't a #fragment or an inline bitmap.
function stripExternalUrls(value) {
  return String(value).replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _q, ref) => (isLocalRef(ref.trim()) ? match : 'none'));
}

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  const value = String(data.attrValue || '').trim();
  if (data.attrName === 'href' || data.attrName === 'xlink:href') {
    if (!isLocalRef(value)) data.keepAttr = false;
  } else if (UNSAFE_CSS_VALUE.test(value)) {
    data.keepAttr = false;
  } else if (/url\(/i.test(value)) {
    data.attrValue = stripExternalUrls(value);
  }
});

function isSvgDataUrl(dataUrl) {
  return /^data:image\/svg\+xml[;,]/i.test(dataUrl || '');
}

function svgError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_SVG' });
}

function decodeDataUrl(dataUrl) {
  // Cheap size check before decoding anything: the encoded form is never
  // smaller than 4/3 of the bytes for base64, or the bytes for percent-encoding.
  if (dataUrl.length > MAX_SVG_BYTES * 3) {
    throw svgError(`SVG too large. Limit is ${MAX_SVG_BYTES / 1024 / 1024} MB.`);
  }
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw svgError('That SVG upload is malformed.');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (/;base64/i.test(header)) return Buffer.from(body, 'base64').toString('utf8');
  try {
    return decodeURIComponent(body);
  } catch {
    throw svgError('That SVG upload is malformed.');
  }
}

/**
 * Any SVG data URL (base64 or percent-encoded) → the same bytes as a base64 data
 * URL. addMedia runs this before hashing: its content hash base64-decodes, which
 * on a percent-encoded URL would hash garbage and let different SVGs collide on
 * the dedupe key and the storage filename.
 */
function normalizeSvgDataUrl(dataUrl) {
  return `data:image/svg+xml;base64,${Buffer.from(decodeDataUrl(dataUrl), 'utf8').toString('base64')}`;
}

/**
 * data:image/svg+xml data_url in → sanitized base64 data_url out, with its
 * intrinsic size (from width/height or viewBox; null when it declares neither).
 */
function sanitizeSvgDataUrl(dataUrl) {
  const text = decodeDataUrl(dataUrl);
  if (Buffer.byteLength(text, 'utf8') > MAX_SVG_BYTES) {
    throw svgError(`SVG too large (${(Buffer.byteLength(text, 'utf8') / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_SVG_BYTES / 1024 / 1024} MB.`);
  }

  // Parse as XML (not HTML) so namespaces and attribute casing like viewBox survive.
  const parse = (source) => {
    const doc = new window.DOMParser().parseFromString(source, 'image/svg+xml');
    const el = doc.documentElement;
    if (!el || el.nodeName === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
      throw svgError('That file is not a valid SVG.');
    }
    return el;
  };
  let root = parse(text);
  if (root.localName !== 'svg') throw svgError('That file is not an SVG image.');
  // A standalone .svg without the namespace parses into no namespace: it renders as
  // nothing in <img>, and DOMPurify won't treat it as SVG. Re-parse with it added.
  if (root.namespaceURI !== SVG_NS) {
    root = parse(text.replace(/<svg\b/i, `<svg xmlns="${SVG_NS}"`));
  }

  try {
    DOMPurify.sanitize(root, {
      IN_PLACE: true,
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'script', 'style'],
      FORBID_ATTR: ['style'],
      // <use> is how design tools reference symbols; the href hook above limits
      // it to in-document #fragments, which is what makes it safe to allow.
      ADD_TAGS: ['use'],
    });
  } catch (err) {
    // DOMPurify refuses in place when the root itself would have to go.
    throw svgError(`That SVG could not be sanitized (${err.message}).`);
  }

  const clean = new window.XMLSerializer().serializeToString(root);
  const buffer = Buffer.from(clean, 'utf8');

  let width = null;
  let height = null;
  try {
    const size = imageSize(buffer);
    width = size.width || null;
    height = size.height || null;
  } catch {
    // No width/height/viewBox: still a valid SVG, it just has no intrinsic size.
  }

  return { data_url: `data:image/svg+xml;base64,${buffer.toString('base64')}`, width, height };
}

module.exports = { isSvgDataUrl, normalizeSvgDataUrl, sanitizeSvgDataUrl, MAX_SVG_BYTES };
