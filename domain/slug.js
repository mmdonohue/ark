'use strict';

// Shared slug sanitization — used anywhere a title/bucket name needs to
// become a URL/lookup-safe slug (ArkActions.create, MediaImportActions.
// promoteBucket). Kept as one function so the sanitization rule can't drift
// between call sites.
function toSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
}

module.exports = { toSlug };
