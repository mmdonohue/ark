'use strict';

// pickDisplayableImage — the one rule for "which image row, if any, should
// represent this artifact visually": has an actual viewable URL, and isn't
// an archival_master (a paired TIFF with no viewable representation at
// all). Same rule ArkActions.graph's mediaInfo and CatalogActions.js's
// publishItems each independently needed — mirrors
// frontend/utils/artifactMedia.ts's pickDisplayableImage/isDisplayable,
// which the Grid template uses for the same decision client-side.

function isDisplayableImage(m) {
  return m.media_type === 'image'
    && !!(m.thumbnail_url || m.url || m.data_url)
    && m.metadata?.representation_role !== 'archival_master';
}

// mediaRows: all media rows for one artifact (any media_type mixed in is
// fine — filtered here). Returns the row, or null if none are displayable.
function pickDisplayableImage(mediaRows) {
  return (mediaRows || []).find(isDisplayableImage) || null;
}

function imageSrcFor(m) {
  if (!m) return null;
  return m.thumbnail_url || m.url || m.data_url || null;
}

// Catalog cards show a small fixed-size gallery (4 photos), not every image
// an item artifact has — same "bounded, not exhaustive" reasoning
// ArkActions.list's FALLBACK_COVER_CANDIDATES already uses for cover
// resolution.
function pickDisplayableImages(mediaRows, limit = 4) {
  return (mediaRows || [])
    .filter(isDisplayableImage)
    .slice(0, limit)
    .map(imageSrcFor);
}

module.exports = { isDisplayableImage, pickDisplayableImage, pickDisplayableImages, imageSrcFor };
