'use strict';

// Lamb Mode — the vessel's quiet setting (docs/proposals/universal-lamb-mode.md).
//
// One artifact per vessel (per store on a shared database):
//   artifact_type 'vessel_mode', slug 'vessel-mode',
//   context { mode: 'normal' | 'lamb', since, by, note, visibility: 'private' }
// It lives in the vessel's own database, so it persists offline and moves
// with the vessel. Only vessel.quiet / vessel.resume change it.
//
// It is read with owner rank whatever the caller's rank: the setting governs
// every caller, so a caller who can't see it mustn't slip past it.

const Artifact = require('../domain/Artifact');
const crypto = require('crypto');

const TYPE = 'vessel_mode';
const SLUG = 'vessel-mode';
const NORMAL = Object.freeze({ mode: 'normal' });

// Actions that do work: refused while quiet unless the owner overrides it in
// the foreground. system.cycle isn't here — it answers { quiet: true } itself,
// so the timer keeps a clean exit.
const WORK = new Set([
  'harness.run', 'harness.watch', 'workflow.advance', 'sync.push', 'pipeline.run',
  'media.classify.vision', 'media.classify_batch', 'cinema.render_reel',
]);

const _ownerCtx = store_id => ({ store_id, rank: 100 });
const _parse = c => (typeof c === 'string' ? JSON.parse(c || '{}') : (c || {}));

async function _row(store_id) {
  if (!store_id) throw Object.assign(new Error('Lamb Mode requires a store_id'), { status: 400, code: 'STORE_REQUIRED' });
  const rows = await Artifact.query({ artifact_type: TYPE, filters: [['slug', 'eq', SLUG]], limit: 2, select: 'id, context, updated_at' }, _ownerCtx(store_id));
  if (rows.length > 1) throw Object.assign(new Error('Multiple Lamb Mode records exist; resolve them before continuing'), { status: 409, code: 'DUPLICATE_VESSEL_MODE' });
  const [row] = rows;
  return row || null;
}

// → { mode, since?, by?, note?, id? }
async function current(store_id) {
  const row = await _row(store_id);
  if (!row) return { ...NORMAL };
  const c = _parse(row.context);
  if (!['normal', 'lamb'].includes(c.mode)) throw new Error('Invalid Lamb Mode record');
  return { mode: c.mode, since: c.since || null, by: c.by || null, note: c.note || null, skip_before: c.skip_before || null, id: row.id, revision: c.revision || null };
}

// A deterministic ID makes concurrent first writes contend on the primary key.
function _id(store_id) {
  const hash = crypto.createHash('sha256').update(`ark:vessel-mode:${store_id}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const x = hash.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function set(store_id, ctx, fields, previous) {
  const row = await _row(store_id);
  const context = { visibility: 'private', ...fields, revision: crypto.randomUUID() };
  const conflict = () => Object.assign(new Error('Lamb Mode changed concurrently; read it and try again'), { status: 409, code: 'MODE_CHANGED' });
  if ((row?.id || null) !== (previous.id || null)) throw conflict();
  if (row) {
    const old = _parse(row.context);
    if (old.mode !== previous.mode || (old.revision || null) !== previous.revision) throw conflict();
    const a = await Artifact.findById(row.id, ctx);
    if (!a) throw new Error('Lamb Mode record is unavailable');
    a.assign({ context });
    await a.prepare();
    await a.authorize('Artifact.save');
    let q = Artifact.db.from('artifacts').update({ context, updated_at: a.get('updated_at'), ...(ctx.user_id ? { updated_by: ctx.user_id } : {}) })
      .eq('id', row.id).eq('store_id', store_id).eq('context->>mode', previous.mode);
    q = previous.revision ? q.eq('context->>revision', previous.revision) : q.is('context->>revision', null);
    const { data, error } = await q.select('*').maybeSingle();
    if (error) throw new Error(`Lamb Mode update failed: ${error.message}`);
    if (!data) throw conflict();
    return new Artifact(data, { context: ctx });
  }
  const a = new Artifact({ artifact_type: TYPE, slug: SLUG, title: 'Vessel mode', context }, { context: ctx });
  await a.prepare();
  a.set('id', _id(store_id));
  await a.authorize('Artifact.save');
  const { data, error } = await Artifact.db.from('artifacts').insert(a.data).select('*').single();
  if (error) {
    if (error.code === '23505' || /UNIQUE constraint|duplicate key/i.test(error.message)) throw conflict();
    throw new Error(`Lamb Mode creation failed: ${error.message}`);
  }
  return new Artifact(data, { context: ctx });
}

// Who may change or override the mode: the owner, acting now — never an
// agent's callback, a cycle, or a resumed chain, whatever rank they carry.
const isForegroundOwner = ctx => (ctx.rank ?? 0) >= 100 && !ctx.delegation
  && !['system.cycle', 'harness', 'resume'].includes(ctx.source);

// The dispatch() check. → null (go ahead) or an error to throw. Only reads
// the mode when the action could be held, so ordinary calls cost nothing.
//   background: an automated workflow step's action (meta.workflow_run), and
//               any write an agent makes through its callback — always held
//   work:       WORK actions — held unless meta.quiet_override from the
//               foreground owner (recorded on the ledger by the caller's meta)
async function check({ action, capability, ctx, meta = {} }) {
  // vessel.* decide for themselves (owner, in the foreground) — refusing an
  // agent's vessel.resume here would only hide the real reason.
  if (action.startsWith('vessel.')) return null;
  const delegatedWrite = !!ctx.delegation && !(capability || '').endsWith('.read') && capability !== 'artifact.read';
  const background = !!meta.workflow_run || delegatedWrite;
  const work = WORK.has(action);
  if (!background && !work) return null;
  const m = await current(ctx.store_id);
  if (m.mode !== 'lamb') return null;
  if (work && !background && meta.quiet_override === true && isForegroundOwner(ctx)) return null;
  const why = background ? 'background work waits until the owner resumes' : 'run it from Mission Control or the CLI with the override to do it anyway';
  return Object.assign(new Error(`Lamb Mode is on (since ${m.since || '?'}): ${action} is held — ${why}.`), {
    status: 423, code: 'LAMB_MODE', mode: m, overridable: work && !background,
  });
}

module.exports = { current, set, check, isForegroundOwner, WORK, TYPE, SLUG, idForStore: _id };
