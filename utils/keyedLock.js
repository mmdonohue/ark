'use strict';

// Serializes async work per key within this process: a check-then-insert
// (is this alias free? then create it) can't interleave with another for the
// same key. Not a cross-process lock — a vessel is one process.

const tails = new Map();

async function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(res => { release = res; });
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

module.exports = { withLock };
