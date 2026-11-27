'use strict';

// The vessel data format: SQLite's PRAGMA user_version on every vessel.
//
// Additive changes (a new table or column that older code ignores) keep it.
// A change older code would misread bumps it, with its own reviewed
// migration plan and a backup first. A runtime refuses to open a vessel
// whose format is newer than DATA_FORMAT, and a rollback refuses a target
// that can't read the vessels as they are now.
//
// Runtimes from before the guard existed (0.1.0, 0.2.0) record no format.
// They read format 1, the baseline: every change up to it was additive.

const DATA_FORMAT = 1;
const BASELINE = 1;

module.exports = { DATA_FORMAT, BASELINE };
