'use strict';

// Schedule math for scheduled events. Pure functions, no I/O.
//
// A schedule is one of:
//   { kind: 'once',  start_at }
//   { kind: 'every', every: '<n>h' | '<n>d' | '<n>w', start_at, end_at? }
//
// start_at / end_at are absolute instants (UTC ISO). The event's IANA
// timezone decides what "every day" means:
//   - h steps are absolute (every 6h is always 6h apart)
//   - d / w steps keep the local wall-clock time: a 09:00 daily event stays
//     at 09:00 across a DST change (so that day is 23h or 25h long)
// A local time that doesn't exist (spring-forward gap) moves forward by the
// gap; an ambiguous one (fall-back overlap) takes the first instance.
//
// `every` uses the same <n>h / <n>d vocabulary as harness.watch's
// schedule.every, plus <n>w.

const UNIT_MS = { h: 3600000 };
const UNIT_DAYS = { d: 1, w: 7 };
const MAX_N = 1000;

function parseEvery(every) {
  const m = /^(\d{1,4})([hdw])$/.exec(String(every || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > MAX_N) return null;
  return { n, unit: m[2] };
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const _fmt = new Map();
function _formatter(tz) {
  if (!_fmt.has(tz)) {
    _fmt.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return _fmt.get(tz);
}

// Wall-clock parts of an instant in a timezone.
function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of _formatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Offset of the timezone from UTC at an instant, in ms (LA in winter = -8h).
function _offset(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant a local wall-clock time happens in a timezone.
function zonedToUtc({ y, m, d, h = 0, mi = 0, s = 0 }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const o1 = _offset(guess, tz);
  const t1 = guess - o1;
  const o2 = _offset(t1, tz);
  if (o1 === o2) return t1;            // ordinary, or the first instance of an overlap
  const t2 = guess - o2;
  if (_offset(t2, tz) === o2) return t2;
  return Math.max(t1, t2);             // gap: shift forward by the gap
}

// '2026-11-16T09:00' (no offset) → instant in tz.
function parseLocal(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(local || ''));
  if (!m) return null;
  const parts = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  if (parts.m < 1 || parts.m > 12 || parts.d < 1 || parts.d > 31 || parts.h > 23 || parts.mi > 59 || parts.s > 59) return null;
  const check = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (check.getUTCMonth() !== parts.m - 1) return null; // Feb 30 etc.
  return zonedToUtc(parts, tz);
}

// ISO with an explicit offset or Z → instant. Bare local strings are refused
// here on purpose: their meaning depends on a timezone (use parseLocal).
function parseInstant(iso) {
  if (typeof iso !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function localString(ms, tz) {
  const p = zonedParts(ms, tz);
  const z = n => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

// k-th occurrence (k >= 0) of an 'every' schedule.
function _nth(schedule, tz, k, base) {
  const { n, unit } = parseEvery(schedule.every);
  const start = Date.parse(schedule.start_at);
  if (UNIT_MS[unit]) return start + k * n * UNIT_MS[unit];
  const day = new Date(Date.UTC(base.y, base.m - 1, base.d + k * n * UNIT_DAYS[unit]));
  return zonedToUtc({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h: base.h, mi: base.mi, s: base.s }, tz);
}

// Occurrences in [from, to), oldest first, at most `limit`.
function occurrences(schedule, tz, { from, to = Infinity, limit = 100 } = {}) {
  const out = [];
  if (!schedule || limit <= 0) return out;
  const start = Date.parse(schedule.start_at);
  const end   = schedule.end_at ? Date.parse(schedule.end_at) : Infinity;

  if (schedule.kind === 'once') {
    if (start >= from && start < to) out.push(start);
    return out;
  }
  if (schedule.kind !== 'every') return out;

  const { n, unit } = parseEvery(schedule.every);
  const approxStep = UNIT_MS[unit] ? n * UNIT_MS[unit] : n * UNIT_DAYS[unit] * 86400000;
  const base = zonedParts(start, tz);
  // Start a step early (DST can shift a local-time occurrence by an hour)
  // and walk forward; the loop is bounded by `limit` and `to`.
  let k = Math.max(0, Math.floor((from - start) / approxStep) - 1);
  for (let early = 0; out.length < limit; k++) {
    const t = _nth(schedule, tz, k, base);
    if (t >= to || t > end) break;
    if (t >= from) out.push(t);
    else if (++early > 4) break; // the estimate is at most a couple of steps early; never loop on bad input
  }
  return out;
}

const nextOccurrence = (schedule, tz, after) => occurrences(schedule, tz, { from: after, limit: 1 })[0] ?? null;

function describe(schedule) {
  if (!schedule) return 'unscheduled';
  if (schedule.kind === 'once') return 'once';
  const { n, unit } = parseEvery(schedule.every) || {};
  const word = { h: 'hour', d: 'day', w: 'week' }[unit];
  return n === 1 ? `every ${word}` : `every ${n} ${word}s`;
}

module.exports = {
  parseEvery, isValidTimezone, zonedParts, zonedToUtc, parseLocal, parseInstant,
  localString, occurrences, nextOccurrence, describe,
};
