'use strict';

// EventActions — scheduled intent: something planned to happen, once or on
// a repeat, in a timezone. An event is an `artifact_type: 'event'` artifact
// whose schedule lives in context and is owned by these actions:
//
//   context: {
//     event_type:       'dev.review' | 'farm.irrigation_check' | …  (namespaced, extensible)
//     state:            'active' | 'paused' | 'cancelled'
//     timezone:         IANA name — what "every day at 09:00" means
//     schedule:         { kind: 'once', start_at } | { kind: 'every', every, start_at, end_at? }
//     schedule_version: bumped on every reschedule (Phase 3 occurrence keys)
//     action_ref:       { kind: 'task', id } | null — work it relates to (not executed here)
//   }
//
// Not to be confused with `artifact_events`, which is history (what already
// happened to an artifact). Every change made here is also written there.
//
// An `event` artifact WITHOUT a schedule is still valid — Seravanna's editor
// makes plain, free-form events. It just isn't scheduled: it has no
// occurrences, and event.update can schedule it later.
//
// Nothing here runs anything. Occurrences are computed on read; firing them
// is Phase 3's system.cycle.

const Artifact = require('../domain/Artifact');
const ArtifactRelation = require('../domain/ArtifactRelation');
const { _recordEvent } = require('./ArtifactActions');
const S = require('../utils/eventSchedule');

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
const DAY = 86400000;
const MAX_WINDOW_DAYS = 366;
const MAX_OCCURRENCES = 500;

const _fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const _actor = ctx => ctx.user_id || ctx.ark_actor_id || null;
const _iso = ms => new Date(ms).toISOString();

// ── validation ───────────────────────────────────────────────────────────────

function _eventType(t) {
  if (typeof t !== 'string' || t.length > 64 || !EVENT_TYPE.test(t)) {
    throw _fail(422, 'BAD_EVENT_TYPE', 'event_type must be a lowercase dotted name like "dev.review" (≤ 64 chars)');
  }
  return t;
}

function _timezone(tz) {
  if (!S.isValidTimezone(tz)) throw _fail(422, 'BAD_TIMEZONE', `Unknown timezone "${tz}" — use an IANA name like "America/Los_Angeles"`);
  return tz;
}

// One instant from either an absolute ISO (with offset) or a local wall time
// in the event's timezone — never both, never a bare string read as UTC.
function _instant(abs, local, tz, label) {
  if (abs != null && local != null) throw _fail(422, 'BAD_SCHEDULE', `Give ${label}_at or ${label}_local, not both`);
  if (abs != null) {
    const ms = S.parseInstant(abs);
    if (ms == null) throw _fail(422, 'BAD_SCHEDULE', `${label}_at must be ISO 8601 with an offset or Z`);
    return ms;
  }
  if (local != null) {
    const ms = S.parseLocal(local, tz);
    if (ms == null) throw _fail(422, 'BAD_SCHEDULE', `${label}_local must look like 2026-11-16T09:00`);
    return ms;
  }
  return null;
}

// Normalizes caller input into the stored shape. `now` guards one-time
// events against being scheduled in the past.
function _schedule(input, tz, now) {
  if (!input || typeof input !== 'object') throw _fail(422, 'BAD_SCHEDULE', 'schedule is required');
  const start = _instant(input.start_at, input.start_local, tz, 'start');
  if (start == null) throw _fail(422, 'BAD_SCHEDULE', 'schedule needs start_at or start_local');

  if (input.kind === 'once') {
    if (start < now - 60000) throw _fail(422, 'BAD_SCHEDULE', 'A one-time event can\'t start in the past');
    return { kind: 'once', start_at: _iso(start) };
  }
  if (input.kind === 'every') {
    if (!S.parseEvery(input.every)) throw _fail(422, 'BAD_SCHEDULE', 'every must be <n>h, <n>d or <n>w (1–1000)');
    const end = _instant(input.end_at, input.end_local, tz, 'end');
    if (end != null && end <= start) throw _fail(422, 'BAD_SCHEDULE', 'end must be after start');
    return { kind: 'every', every: input.every, start_at: _iso(start), ...(end != null ? { end_at: _iso(end) } : {}) };
  }
  throw _fail(422, 'BAD_SCHEDULE', 'schedule.kind must be "once" or "every"');
}

async function _actionRef(ctx, ref) {
  if (ref == null) return null;
  if (ref.kind !== 'task' || !ref.id) throw _fail(422, 'BAD_ACTION_REF', 'action_ref must be { kind: "task", id }');
  const task = await Artifact.findById(ref.id, ctx);
  if (!task || task.get('artifact_type') !== 'task') throw _fail(404, 'ACTION_REF_NOT_FOUND', 'action_ref task not found');
  return { kind: 'task', id: ref.id };
}

async function _loadEvent(ctx, event_id) {
  if (!event_id) throw _fail(400, 'MISSING_EVENT_ID', 'event_id is required');
  const ev = await Artifact.findById(event_id, ctx);
  if (!ev || ev.get('artifact_type') !== 'event') throw _fail(404, 'NOT_FOUND', 'Event not found');
  return ev;
}

// ── writes ───────────────────────────────────────────────────────────────────

// payload: { title, summary?, body?, event_type, timezone, schedule, action_ref?, project_id? }
async function create(ctx, payload, packet) {
  const { title, summary, body, project_id } = payload;
  if (!title || !String(title).trim()) throw _fail(400, 'MISSING_TITLE', 'title is required');
  const timezone = _timezone(payload.timezone);
  const context = {
    visibility: 'private',
    event_type: _eventType(payload.event_type),
    state: 'active',
    timezone,
    schedule: _schedule(payload.schedule, timezone, Date.now()),
    schedule_version: 1,
    action_ref: await _actionRef(ctx, payload.action_ref),
    created_by: _actor(ctx),
  };

  let container = null;
  if (project_id) {
    const ark = await Artifact.findById(project_id, ctx);
    if (!ark || ark.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
    container = ark.id;
  } else {
    container = await Artifact.getOrCreateEphemera(ctx);
  }

  const ev = new Artifact({
    artifact_type: 'event',
    title: String(title).trim().slice(0, 200),
    summary: summary ? String(summary).slice(0, 280) : null,
    body: body ? String(body) : null,
    status: 'published',
    context,
  }, { context: ctx });
  await ev.save();

  if (container) {
    const order_index = (await ArtifactRelation.maxOrderIndex(container, 'contains')) + 1;
    await new ArtifactRelation({ source_artifact_id: container, target_artifact_id: ev.id, relation_type: 'contains', order_index }, { context: ctx }).save();
  }

  await _recordEvent(ctx, {
    artifact_id: ev.id, event_type: 'event.scheduled', event_name: 'Event scheduled',
    payload: { event_type: context.event_type, timezone, schedule: context.schedule, version: 1, by: _actor(ctx) },
    related_artifact_id: container,
  });

  packet._objects['event'] = ev.data;
  packet.log.push(`event.create → ${ev.id} "${ev.get('title')}" ${S.describe(context.schedule)}`);
  return { data: { event: ev.data } };
}

// payload: { event_id, title?, summary?, body?, event_type?, timezone?, schedule?, action_ref? }
// A new schedule or timezone is a reschedule: version bumps, history records
// both the old and new schedule. Earlier history is never rewritten.
async function update(ctx, payload, packet) {
  const ev = await _loadEvent(ctx, payload.event_id);
  const c = ev.get('context') || {};
  if (c.state === 'cancelled') throw _fail(409, 'EVENT_STATE', 'A cancelled event can\'t be changed');

  const next = { ...c };
  const fields = {};
  if (payload.title !== undefined) {
    if (!String(payload.title || '').trim()) throw _fail(400, 'MISSING_TITLE', 'title can\'t be empty');
    fields.title = String(payload.title).trim().slice(0, 200);
  }
  if (payload.summary !== undefined) fields.summary = payload.summary ? String(payload.summary).slice(0, 280) : null;
  if (payload.body !== undefined)    fields.body    = payload.body ? String(payload.body) : null;
  if (payload.event_type !== undefined) next.event_type = _eventType(payload.event_type);
  if (payload.action_ref !== undefined) next.action_ref = await _actionRef(ctx, payload.action_ref);

  const rescheduling = payload.schedule !== undefined || payload.timezone !== undefined;
  if (rescheduling) {
    next.timezone = _timezone(payload.timezone ?? c.timezone);
    if (payload.schedule === undefined && !c.schedule) throw _fail(422, 'BAD_SCHEDULE', 'schedule is required to schedule this event');
    // Re-validate even a kept schedule: its local meaning changes with the timezone.
    const input = payload.schedule ?? { ...c.schedule, start_local: S.localString(Date.parse(c.schedule.start_at), c.timezone), start_at: undefined,
      ...(c.schedule.end_at ? { end_local: S.localString(Date.parse(c.schedule.end_at), c.timezone), end_at: undefined } : {}) };
    next.schedule = _schedule(input, next.timezone, Date.now());
    next.schedule_version = (c.schedule_version || 0) + 1;
    if (!c.state) { next.state = 'active'; if (!next.event_type) throw _fail(422, 'BAD_EVENT_TYPE', 'event_type is required to schedule this event'); }
  }

  if (!Object.keys(fields).length && JSON.stringify(next) === JSON.stringify(c)) throw _fail(400, 'NO_CHANGES', 'Nothing to update');
  ev.assign({ ...fields, context: next });
  await ev.save();

  if (rescheduling) {
    await _recordEvent(ctx, {
      artifact_id: ev.id, event_type: 'event.rescheduled', event_name: c.schedule ? 'Event rescheduled' : 'Event scheduled',
      payload: {
        from: c.schedule ? { timezone: c.timezone, schedule: c.schedule, version: c.schedule_version } : null,
        to: { timezone: next.timezone, schedule: next.schedule, version: next.schedule_version },
        by: _actor(ctx),
      },
    });
  } else {
    await _recordEvent(ctx, {
      artifact_id: ev.id, event_type: 'event.updated', event_name: 'Event updated',
      payload: { fields: [...Object.keys(fields), ...['event_type', 'action_ref'].filter(k => payload[k] !== undefined)], by: _actor(ctx) },
    });
  }

  packet._objects['event'] = ev.data;
  packet.log.push(`event.update → ${ev.id}${rescheduling ? ` rescheduled v${next.schedule_version}` : ''}`);
  return { data: { event: ev.data } };
}

const TRANSITIONS = {
  pause:  { from: ['active'],           to: 'paused',    type: 'event.paused',    name: 'Event paused' },
  resume: { from: ['paused'],           to: 'active',    type: 'event.resumed',   name: 'Event resumed' },
  cancel: { from: ['active', 'paused'], to: 'cancelled', type: 'event.cancelled', name: 'Event cancelled' },
};

function _transition(verb) {
  const t = TRANSITIONS[verb];
  return async function (ctx, payload, packet) {
    const ev = await _loadEvent(ctx, payload.event_id);
    const c = ev.get('context') || {};
    if (!c.schedule) throw _fail(409, 'EVENT_UNSCHEDULED', 'This event has no schedule — schedule it with event.update first');
    if (!t.from.includes(c.state)) throw _fail(409, 'EVENT_STATE', `Event is ${c.state}; only ${t.from.join(' or ')} events can be ${t.to}`);

    const note = payload.note ? String(payload.note).trim().slice(0, 2000) : null;
    ev.assign({ context: { ...c, state: t.to } });
    await ev.save();
    await _recordEvent(ctx, {
      artifact_id: ev.id, event_type: t.type, event_name: t.name,
      payload: { from: c.state, to: t.to, by: _actor(ctx), ...(note ? { note } : {}) },
    });

    packet._objects['event'] = ev.data;
    packet.log.push(`event.${verb} → ${ev.id} ${c.state} → ${t.to}`);
    return { data: { event: ev.data } };
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

// payload: { project_id?, event_id?, from?, to?, days?, event_type?, include_paused?, limit? }
// Occurrences are computed for the window [from, to) — default now → +14 days,
// at most 366 days — and capped at `limit` (≤ 500), soonest first.
async function list(ctx, payload, packet) {
  const now  = Date.now();
  const from = payload.from != null ? S.parseInstant(payload.from) : now;
  if (from == null) throw _fail(422, 'BAD_WINDOW', 'from must be ISO 8601 with an offset or Z');
  const days = Math.min(Math.max(Number(payload.days) || 14, 1), MAX_WINDOW_DAYS);
  const to   = payload.to != null ? S.parseInstant(payload.to) : from + days * DAY;
  if (to == null || to <= from) throw _fail(422, 'BAD_WINDOW', 'to must be ISO 8601 and after from');
  if (to - from > MAX_WINDOW_DAYS * DAY) throw _fail(422, 'BAD_WINDOW', `The window is at most ${MAX_WINDOW_DAYS} days`);
  const limit = Math.min(Math.max(Number(payload.limit) || 200, 1), MAX_OCCURRENCES);

  let rows;
  if (payload.event_id) {
    rows = [(await _loadEvent(ctx, payload.event_id)).data];
  } else {
    let ids;
    if (payload.project_id) {
      const ark = await Artifact.findById(payload.project_id, ctx);
      if (!ark || ark.get('artifact_type') !== 'ark') throw _fail(404, 'PROJECT_NOT_FOUND', 'Project not found');
      const { data: rels, error } = await Artifact.db.from('artifact_relations')
        .select('target_artifact_id').eq('source_artifact_id', ark.id).eq('relation_type', 'contains');
      if (error) throw new Error(error.message);
      ids = (rels || []).map(r => r.target_artifact_id);
    }
    rows = await Artifact.query({ artifact_type: 'event', ids, limit: 1000 }, ctx);
  }

  const states = new Set(['active', ...(payload.include_paused ? ['paused'] : [])]);
  const events = rows
    .map(r => ({ ...r, context: typeof r.context === 'string' ? JSON.parse(r.context) : (r.context || {}) }))
    .filter(r => r.context.schedule && (payload.event_id || states.has(r.context.state)))
    .filter(r => !payload.event_type || r.context.event_type === payload.event_type);

  let occurrences = [];
  for (const e of events) {
    if (e.context.state !== 'active') continue; // paused/cancelled have no upcoming occurrences
    // limit + 1 so a window that overflows is reported as truncated
    for (const t of S.occurrences(e.context.schedule, e.context.timezone, { from, to, limit: limit + 1 })) {
      occurrences.push({
        event_id: e.id, at: _iso(t), local: S.localString(t, e.context.timezone), timezone: e.context.timezone,
        title: e.title, event_type: e.context.event_type, recurrence: S.describe(e.context.schedule),
      });
    }
  }
  occurrences.sort((a, b) => a.at.localeCompare(b.at));
  const truncated = occurrences.length > limit;
  occurrences = occurrences.slice(0, limit);

  const summaries = events.map(e => {
    const next = e.context.state === 'active' ? S.nextOccurrence(e.context.schedule, e.context.timezone, now) : null;
    return {
      id: e.id, title: e.title, event_type: e.context.event_type, state: e.context.state,
      timezone: e.context.timezone, schedule: e.context.schedule, recurrence: S.describe(e.context.schedule),
      schedule_version: e.context.schedule_version, action_ref: e.context.action_ref || null,
      next_at: next != null ? _iso(next) : null,
    };
  });

  packet.log.push(`event.list → ${summaries.length} events, ${occurrences.length} occurrences ${_iso(from).slice(0, 10)}…${_iso(to).slice(0, 10)}${truncated ? ' (truncated)' : ''}`);
  return { data: { events: summaries, occurrences, window: { from: _iso(from), to: _iso(to) }, truncated } };
}

module.exports = {
  create, update, list,
  pause: _transition('pause'), resume: _transition('resume'), cancel: _transition('cancel'),
};
