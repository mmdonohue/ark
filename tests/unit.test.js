'use strict';

// Load env before any module that touches supabase
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Subjects ──────────────────────────────────────────────────────────────────

const { dispatch, ACTION_REGISTRY: REGISTRY, _assertCapability } = require('../index');
const { _internals: TR }   = require('../core/TemplateResolver');
const { _internals: CE }   = require('../core/ChainExecutor');
const { _internals: Art }  = require('../domain/Artifact');
const { _internals: PC }   = require('../core/PCER');
const { _internals: TA }   = require('../actions/TraceActions');
const ArtifactActions      = require('../actions/ArtifactActions');
const Packet               = require('../core/Packet');
const LLMAdapter           = require('../adapters/llm');
const { _internals: LLM }  = require('../adapters/llm');
const { parseExport, parseConversation, conversationHash } = require('../utils/chatParser');
const { _internals: CP }   = require('../utils/chatParser');

// Minimal concrete subclass — Packet itself requires a static table to be set
class TestPacket extends Packet { static table = '_test'; }

const { _emptyContract, _extractContract, _merge, _deepMerge } = TR;
const { _evaluateResolution, _shapePayload }                   = CE;
const { _packetFingerprint, _isVisibleArtifact }               = Art;
const { _emptyExecutionPacket, _buildTraceList, _projectScope, _pick, _applyMerge, _hashContract } = PC;
const { _defaultCapabilities }                                 = TA;
const { DEFAULT_MODEL, DEFAULT_BASE_URL }                      = LLM;

// ── Artifact event history ──────────────────────────────────────────────────

test('ArtifactActions: registry exposes artifact.events.list', () => {
  assert.ok(REGISTRY['artifact.events.list']);
  assert.equal(REGISTRY['artifact.events.list'].capability, 'artifact.read');
});

test('ArtifactActions: recordArtifactEvent helper is available', () => {
  assert.equal(typeof ArtifactActions._recordEvent, 'function');
});

test('Artifact: _isVisibleArtifact hides archived rows from the graph', () => {
  assert.equal(_isVisibleArtifact({ inactive: false }), true);
  assert.equal(_isVisibleArtifact({ inactive: true }), false);
  assert.equal(_isVisibleArtifact(null), false);
});

// ── TemplateResolver: _emptyContract ─────────────────────────────────────────

test('_emptyContract: has all required top-level keys', () => {
  const c = _emptyContract();
  for (const key of ['id','slug','title','domain_id','entry_relation','entry_artifact_type',
                     'fields','defaults','validators','workflow_hooks','ai_hints','ui','response']) {
    assert.ok(key in c, `missing key: ${key}`);
  }
});

test('_emptyContract: fields, validators, workflow_hooks are empty arrays', () => {
  const c = _emptyContract();
  assert.deepEqual(c.fields, []);
  assert.deepEqual(c.validators, []);
  assert.deepEqual(c.workflow_hooks, []);
});

test('_emptyContract: response block has type, payload, resolution', () => {
  const { response } = _emptyContract();
  assert.equal(response.type, null);
  assert.deepEqual(response.payload, []);
  assert.ok('success' in response.resolution);
  assert.ok('partial' in response.resolution);
  assert.ok('failure' in response.resolution);
});

test('_emptyContract: response.resolution has default label strings', () => {
  const { response } = _emptyContract();
  assert.equal(response.resolution.success, 'all_steps_completed');
  assert.equal(response.resolution.partial, 'some_steps_skipped');
  assert.equal(response.resolution.failure, 'any_required_step_failed');
});

// ── TemplateResolver: _extractContract ───────────────────────────────────────

test('_extractContract: extracts id, slug, title, domain_id from template row', () => {
  const tmpl = { id: 'abc', slug: 'my-tmpl', title: 'My Template', domain_id: 'd1', metadata: {} };
  const c = _extractContract(tmpl);
  assert.equal(c.id, 'abc');
  assert.equal(c.slug, 'my-tmpl');
  assert.equal(c.title, 'My Template');
  assert.equal(c.domain_id, 'd1');
});

test('_extractContract: returns empty arrays/objects for missing metadata fields', () => {
  const c = _extractContract({ id: 'x', metadata: {} });
  assert.deepEqual(c.fields, []);
  assert.deepEqual(c.validators, []);
  assert.deepEqual(c.workflow_hooks, []);
  assert.deepEqual(c.defaults, {});
  assert.deepEqual(c.ai_hints, {});
  assert.deepEqual(c.ui, {});
  assert.deepEqual(c.response, {});
});

test('_extractContract: picks up response block from metadata', () => {
  const tmpl = {
    id: 'x', metadata: {
      response: { type: 'artifact', payload: ['artifact'], resolution: { success: 'done' } },
    },
  };
  const c = _extractContract(tmpl);
  assert.equal(c.response.type, 'artifact');
  assert.deepEqual(c.response.payload, ['artifact']);
  assert.equal(c.response.resolution.success, 'done');
});

test('_extractContract: ignores non-object response in metadata', () => {
  const c = _extractContract({ id: 'x', metadata: { response: 'bad' } });
  assert.deepEqual(c.response, {});
});

test('_extractContract: carries template_content_hash from artifact row', () => {
  const c = _extractContract({ id: 'x', content_hash: 'deadbeef', metadata: {} });
  assert.equal(c.template_content_hash, 'deadbeef');
});

test('_extractContract: template_content_hash is null when artifact has no content_hash', () => {
  const c = _extractContract({ id: 'x', metadata: {} });
  assert.equal(c.template_content_hash, null);
});

test('_emptyContract: has template_content_hash and composed_from fields', () => {
  const c = _emptyContract();
  assert.equal(c.template_content_hash, null);
  assert.deepEqual(c.composed_from, []);
});

// ── TemplateResolver: _merge ─────────────────────────────────────────────────

test('_merge: override slug wins over base slug', () => {
  const base     = { ..._emptyContract(), slug: 'base-slug' };
  const override = { ..._emptyContract(), slug: 'override-slug' };
  assert.equal(_merge(base, override).slug, 'override-slug');
});

test('_merge: workflow_hooks concatenated (base first)', () => {
  const base     = { ..._emptyContract(), workflow_hooks: ['a', 'b'] };
  const override = { ..._emptyContract(), workflow_hooks: ['c'] };
  assert.deepEqual(_merge(base, override).workflow_hooks, ['a', 'b', 'c']);
});

test('_merge: fields keyed by key, override replaces matching base field', () => {
  const base     = { ..._emptyContract(), fields: [{ key: 'name', type: 'text' }] };
  const override = { ..._emptyContract(), fields: [{ key: 'name', type: 'rich_text' }] };
  const merged   = _merge(base, override);
  assert.equal(merged.fields.length, 1);
  assert.equal(merged.fields[0].type, 'rich_text');
});

test('_merge: ui override wins entirely when non-empty', () => {
  const base     = { ..._emptyContract(), ui: { theme: 'dark' } };
  const override = { ..._emptyContract(), ui: { theme: 'light', accent: 'blue' } };
  assert.deepEqual(_merge(base, override).ui, { theme: 'light', accent: 'blue' });
});

test('_merge: ui falls back to base when override ui is empty', () => {
  const base     = { ..._emptyContract(), ui: { theme: 'dark' } };
  const override = { ..._emptyContract(), ui: {} };
  assert.deepEqual(_merge(base, override).ui, { theme: 'dark' });
});

test('_merge: response deep-merges resolution criteria', () => {
  const base     = { ..._emptyContract(), response: { type: 'status', payload: [], resolution: { success: 'done', partial: 'some' } } };
  const override = { ..._emptyContract(), response: { type: 'artifact', payload: ['artifact'], resolution: { success: 'all_complete' } } };
  const merged   = _merge(base, override);
  assert.equal(merged.response.type, 'artifact');
  assert.equal(merged.response.resolution.success, 'all_complete');
  assert.equal(merged.response.resolution.partial, 'some'); // base value preserved
});

// ── TemplateResolver: _deepMerge ─────────────────────────────────────────────

test('_deepMerge: override wins on scalar conflict', () => {
  assert.equal(_deepMerge({ a: 1 }, { a: 2 }).a, 2);
});

test('_deepMerge: nested objects are merged recursively', () => {
  const result = _deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 9, z: 3 } });
  assert.deepEqual(result.a, { x: 1, y: 9, z: 3 });
});

test('_deepMerge: arrays from override replace base (not merged)', () => {
  const result = _deepMerge({ tags: ['a'] }, { tags: ['b', 'c'] });
  assert.deepEqual(result.tags, ['b', 'c']);
});

// ── ChainExecutor: _evaluateResolution ───────────────────────────────────────

test('_evaluateResolution: no skips → success label', () => {
  assert.equal(_evaluateResolution(false), 'all_steps_completed');
});

test('_evaluateResolution: some skipped → partial label', () => {
  assert.equal(_evaluateResolution(true), 'some_steps_skipped');
});

test('_evaluateResolution: custom success label from criteria', () => {
  assert.equal(_evaluateResolution(false, { success: 'custom_done' }), 'custom_done');
});

test('_evaluateResolution: custom partial label from criteria', () => {
  assert.equal(_evaluateResolution(true, { partial: 'my_partial' }), 'my_partial');
});

// ── ChainExecutor: _shapePayload ─────────────────────────────────────────────

test('_shapePayload: no keys declared → returns full payload', () => {
  assert.deepEqual(_shapePayload({ a: 1, b: 2 }, []), { a: 1, b: 2 });
});

test('_shapePayload: null/undefined keys → returns full payload', () => {
  assert.deepEqual(_shapePayload({ a: 1, b: 2 }, null), { a: 1, b: 2 });
});

test('_shapePayload: filters to declared keys only', () => {
  assert.deepEqual(_shapePayload({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
});

test('_shapePayload: missing keys are silently omitted', () => {
  assert.deepEqual(_shapePayload({ a: 1 }, ['a', 'missing']), { a: 1 });
});

// ── Artifact: _packetFingerprint ─────────────────────────────────────────────

test('_packetFingerprint: same input produces same hash', () => {
  const data = { artifact_type: 'note', title: 'Hello', body: 'World', tag_keys: ['a'] };
  assert.equal(_packetFingerprint(data), _packetFingerprint(data));
});

test('_packetFingerprint: different title produces different hash', () => {
  const h1 = _packetFingerprint({ artifact_type: 'note', title: 'Hello' });
  const h2 = _packetFingerprint({ artifact_type: 'note', title: 'Goodbye' });
  assert.notEqual(h1, h2);
});

test('_packetFingerprint: tag_keys order does not affect hash', () => {
  const h1 = _packetFingerprint({ artifact_type: 'note', tag_keys: ['a', 'b'] });
  const h2 = _packetFingerprint({ artifact_type: 'note', tag_keys: ['b', 'a'] });
  assert.equal(h1, h2);
});

test('_packetFingerprint: returns a 64-char hex string (SHA-256)', () => {
  const h = _packetFingerprint({ artifact_type: 'note', title: 'test' });
  assert.match(h, /^[a-f0-9]{64}$/);
});

test('_packetFingerprint: extra runtime fields (id, store_id, created_at) do not affect hash', () => {
  const base = { artifact_type: 'note', title: 'Test' };
  const withMeta = { ...base, id: 'uuid-123', store_id: 'store-abc', created_at: new Date().toISOString() };
  assert.equal(_packetFingerprint(base), _packetFingerprint(withMeta));
});

// ── Packet: core class ───────────────────────────────────────────────────────

test('Packet: get() returns value from initial data', () => {
  const p = new TestPacket({ name: 'test-packet' });
  assert.equal(p.get('name'), 'test-packet');
});

test('Packet: get() returns null for missing key', () => {
  const p = new TestPacket({});
  assert.equal(p.get('nonexistent'), null);
});

test('Packet: assign() merges fields into data', () => {
  const p = new TestPacket({ a: 1 });
  p.assign({ b: 2 });
  assert.equal(p.get('a'), 1);
  assert.equal(p.get('b'), 2);
});

test('Packet: assign() marks keys dirty', () => {
  const p = new TestPacket({ a: 1 });
  p.assign({ b: 2, c: 3 });
  assert.ok(p.dirty.has('b'));
  assert.ok(p.dirty.has('c'));
});

test('Packet: set() is equivalent to assign() for a single field', () => {
  const p = new TestPacket({});
  p.set('foo', 'bar');
  assert.equal(p.get('foo'), 'bar');
  assert.ok(p.dirty.has('foo'));
});

test('Packet: new instance without id has null id', () => {
  const p = new TestPacket({ title: 'test' });
  assert.equal(p.get('id'), null);
});

test('Packet: id getter returns data.id', () => {
  const p = new TestPacket({ id: 'abc-123' });
  assert.equal(p.id, 'abc-123');
});

// ── PCER: _emptyExecutionPacket ───────────────────────────────────────────────

const _mockCtx = () => ({
  user_id: 'u1', store_id: 's1', site_id: 'site1',
  request_id: 'req-1', ip: '127.0.0.1', user_agent: 'test', source: 'test',
  role: 'ADMIN', role_id: 1, rank: 100,
});
const _mockCanonical = (action = 'artifact.create', payload = {}) => ({
  action, payload, meta: { request_id: 'req-1' }, _objects: {},
});

test('_emptyExecutionPacket: carries flat ctx fields for handler compat', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  assert.equal(ep.user_id,  'u1');
  assert.equal(ep.store_id, 's1');
  assert.equal(ep.site_id,  'site1');
  assert.equal(ep.request_id, 'req-1');
});

test('_emptyExecutionPacket: payload is a copy of canonical payload', () => {
  const ep = _emptyExecutionPacket(_mockCanonical('x', { foo: 'bar' }), null, _mockCtx());
  assert.equal(ep.payload.foo, 'bar');
});

test('_emptyExecutionPacket: scope, capabilities, services start empty', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  assert.deepEqual(ep.scope, { requested: {}, granted: {}, denied: {} });
  assert.deepEqual(ep.capabilities, []);
  assert.deepEqual(ep.services, {});
});

test('_emptyExecutionPacket: trace steps start as empty array', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  assert.deepEqual(ep.trace.steps, []);
});

test('_emptyExecutionPacket: provenance stamped with actor + store', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  assert.equal(ep.provenance.actor, 'u1');
  assert.equal(ep.provenance.store, 's1');
  assert.equal(ep.provenance.resolved_at, null);
  assert.deepEqual(ep.provenance.contract, {
    template_id: null, template_slug: null, template_content_hash: null,
    resolved_hash: null, composed_from: [], resolver_version: '1',
  });
});

// ── PCER: _buildTraceList ─────────────────────────────────────────────────────

test('_buildTraceList: includes defaults when contract has no execution_trace', () => {
  const stages = _buildTraceList(null);
  const actions = stages.map(s => s.action);
  assert.ok(actions.includes('trace.open'));
  assert.ok(actions.includes('auth.verify'));
  assert.ok(actions.includes('scope.resolve'));
});

test('_buildTraceList: appends contract execution_trace after defaults', () => {
  const contract = { execution_trace: [{ action: 'payload.project', response: { type: 'merge' } }] };
  const stages = _buildTraceList(contract);
  const actions = stages.map(s => s.action);
  assert.equal(actions[0], 'trace.open');
  assert.equal(actions[actions.length - 1], 'payload.project');
});

test('_buildTraceList: null contract returns only defaults', () => {
  assert.equal(_buildTraceList(null).length, _buildTraceList({ execution_trace: [] }).length);
});

// ── PCER: _projectScope ───────────────────────────────────────────────────────

test('_projectScope: empty scope returns full ctx', () => {
  const ctx = _mockCtx();
  const projected = _projectScope({}, ctx, _mockCanonical());
  assert.equal(projected.user_id, 'u1');
});

test('_projectScope: identity dimension includes user_id only', () => {
  const projected = _projectScope({ identity: 'actor' }, _mockCtx(), _mockCanonical());
  assert.equal(projected.user_id, 'u1');
  assert.equal(projected.store_id, undefined);
});

test('_projectScope: tenant dimension includes store_id only', () => {
  const projected = _projectScope({ tenant: 'current' }, _mockCtx(), _mockCanonical());
  assert.equal(projected.store_id, 's1');
  assert.equal(projected.user_id, undefined);
});

test('_projectScope: services dimension sets _allowed_services', () => {
  const projected = _projectScope({ services: ['storage', 'llm'] }, _mockCtx(), _mockCanonical());
  assert.deepEqual(projected._allowed_services, ['storage', 'llm']);
});

// ── PCER: _pick ───────────────────────────────────────────────────────────────

test('_pick: returns only declared keys', () => {
  assert.deepEqual(_pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
});

test('_pick: silently omits missing keys', () => {
  assert.deepEqual(_pick({ a: 1 }, ['a', 'z']), { a: 1 });
});

// ── PCER: _applyMerge ─────────────────────────────────────────────────────────

test('_applyMerge: assign strategy does a flat Object.assign', () => {
  const target = { a: 1 };
  _applyMerge(target, { b: 2 }, 'assign');
  assert.equal(target.b, 2);
});

test('_applyMerge: deep strategy merges nested objects', () => {
  const target = { scope: { tenant: { store_id: 's1' } } };
  _applyMerge(target, { scope: { identity: { user_id: 'u1' } } }, 'deep');
  assert.equal(target.scope.tenant.store_id, 's1');
  assert.equal(target.scope.identity.user_id, 'u1');
});

// ── PCER: resolve() — integration (no DB, pure trace handlers) ────────────────

test('PCER.resolve: runs all default trace stages and returns ExecutionPacket', async () => {
  const PCER = require('../core/PCER');
  const ctx  = _mockCtx();
  const canonicalPacket = _mockCanonical('artifact.create', { title: 'test' });

  const mockRegistry = {
    'trace.open':    async (_sc, _cp, ep) => { ep.trace._opened = true; },
    'auth.verify':   async (_sc, _cp, _ep) => { /* passes */ },
    'scope.resolve': async (_sc, _cp, _ep) => ({ scope: { test: true }, capabilities: ['artifact.read'] }),
  };
  // Override scope.resolve response type for the merge to work
  // Use the real PCER default trace which has type: merge for scope.resolve
  const ep = await PCER.resolve({ canonicalPacket, contract: null, ctx, registry: mockRegistry });

  assert.equal(ep.user_id, 'u1');
  assert.equal(ep.store_id, 's1');
  assert.equal(ep.payload.title, 'test');
  assert.ok(ep.provenance.resolved_at !== null);
  assert.equal(ep.trace.steps.length, 6); // 6 default stages
});

test('PCER.resolve: gate stage throw propagates with pcer_stage stamped', async () => {
  const PCER = require('../core/PCER');
  const ctx  = _mockCtx();
  const mockRegistry = {
    'trace.open':  async () => {},
    'auth.verify': async () => { throw Object.assign(new Error('no actor'), { status: 401 }); },
  };
  await assert.rejects(
    () => PCER.resolve({ canonicalPacket: _mockCanonical(), contract: null, ctx, registry: mockRegistry }),
    err => err.pcer_stage === 'auth.verify' && err.status === 401,
  );
});

test('PCER.resolve: missing required trace stage throws PCER_MISSING_TRACE', async () => {
  const PCER = require('../core/PCER');
  // Empty registry — trace.open is required
  await assert.rejects(
    () => PCER.resolve({ canonicalPacket: _mockCanonical(), contract: null, ctx: _mockCtx(), registry: {} }),
    err => err.code === 'PCER_MISSING_TRACE',
  );
});

test('PCER.resolve: auth.verify stage scope projects store_id (real DEFAULT_TRACE + real TraceActions.verify)', async () => {
  const PCER = require('../core/PCER');
  const TraceActions = require('../actions/TraceActions');
  const ctx = _mockCtx(); // has store_id: 's1'

  // Use PCER's own default trace declaration and TraceActions' real handler —
  // a hand-rolled mock registry/scope would not have caught the tenant
  // scope-projection bug this test guards against.
  const authStage = PCER.defaultTrace.find(s => s.action === 'auth.verify');
  assert.deepEqual(authStage.scope, { identity: 'actor', tenant: 'current', role: 'current' });

  const mockRegistry = {
    'trace.open':  TraceActions.open,
    'auth.verify': TraceActions.verify,
  };
  const ep = await PCER.resolve({ canonicalPacket: _mockCanonical(), contract: null, ctx, registry: mockRegistry });
  const step = ep.trace.steps.find(s => s.action === 'auth.verify');
  assert.equal(step.status, 'ok');
});

test('PCER.resolve: side_effect stage records produced keys but does not merge into ep', async () => {
  const PCER = require('../core/PCER');
  const ctx  = _mockCtx();
  const contract = {
    execution_trace: [
      { action: 'media.preserve', response: { type: 'side_effect' }, required: true, scope: {} },
    ],
  };
  const mockRegistry = {
    'trace.open':      async () => {},
    'auth.verify':     async () => {},
    'media.preserve':  async () => ({ data: { artifact_id: 'art-1' } }),
  };
  const ep = await PCER.resolve({ canonicalPacket: _mockCanonical(), contract, ctx, registry: mockRegistry });

  assert.equal(ep.artifact_id, undefined); // never merged into the execution packet
  const step = ep.trace.steps.find(s => s.action === 'media.preserve');
  assert.equal(step.type, 'side_effect');
  assert.deepEqual(step.produced, ['artifact_id']);
});

test('PCER.resolve: observe stage preserves the observation in trace but does not merge into ep', async () => {
  const PCER = require('../core/PCER');
  const ctx  = _mockCtx();
  const contract = {
    execution_trace: [
      { action: 'memchart.assess', response: { type: 'observe' }, required: true, scope: {} },
    ],
  };
  const mockRegistry = {
    'trace.open':       async () => {},
    'auth.verify':      async () => {},
    'memchart.assess':  async () => ({ data: { confidence: 0.42 } }),
  };
  const ep = await PCER.resolve({ canonicalPacket: _mockCanonical(), contract, ctx, registry: mockRegistry });

  assert.equal(ep.confidence, undefined); // never merged into the execution packet
  const step = ep.trace.steps.find(s => s.action === 'memchart.assess');
  assert.equal(step.type, 'observe');
  assert.deepEqual(step.observed, { confidence: 0.42 });
});

// ── PipelineRegistry: _resolveRules / _readYaml ──────────────────────────────
// Exercised against the real recipe fixtures in pipelines/ — no DB needed,
// these functions only touch the filesystem.

const { _internals: PR } = require('../core/PipelineRegistry');

// ── SqliteAdapter: connect() creates a missing parent directory ─────────────

test('SqliteAdapter.connect: creates the parent directory if it does not exist', async () => {
  const os = require('os');
  const SqliteAdapter = require('../adapters/sqlite');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-sqlite-test-'));
  const nestedDbPath = path.join(tmpRoot, 'does', 'not', 'exist', 'ark.sqlite');
  assert.ok(!fs.existsSync(path.dirname(nestedDbPath)));

  const adapter = new SqliteAdapter(nestedDbPath);
  await adapter.connect();

  assert.ok(fs.existsSync(nestedDbPath));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── RuleEvaluator ─────────────────────────────────────────────────────────────

const { evaluateRules } = require('../core/RuleEvaluator');

test('evaluateRules: "in" condition matches and applies then', () => {
  const rules = [{ id: 'r1', when: { likely_subject: { in: ['bird', 'yard'] } }, then: { route_to_bucket: 'birds' } }];
  const { result, applied } = evaluateRules(rules, { likely_subject: 'bird' });
  assert.equal(result.route_to_bucket, 'birds');
  assert.deepEqual(applied, ['r1']);
});

test('evaluateRules: "below" does not match when the fact is missing', () => {
  const rules = [{ id: 'r1', when: { confidence: { below: 0.85 } }, then: { route_to_bucket: 'review' } }];
  const { result, applied } = evaluateRules(rules, {});
  assert.equal(result.route_to_bucket, undefined);
  assert.deepEqual(applied, []);
});

test('evaluateRules: "not" does not match when the fact is absent — absent is not "not X"', () => {
  const rules = [{ id: 'r1', when: { capture_year: { not: 2004 } }, then: { include_in_import: false } }];
  const { result, applied } = evaluateRules(rules, {}); // capture_year not in facts at all
  assert.equal(result.include_in_import, undefined);
  assert.deepEqual(applied, []);
});

test('evaluateRules: "not" matches when the fact is present and different', () => {
  const rules = [{ id: 'r1', when: { capture_year: { not: 2004 } }, then: { include_in_import: false } }];
  const { result } = evaluateRules(rules, { capture_year: 1999 });
  assert.equal(result.include_in_import, false);
});

test('evaluateRules: later rules override earlier ones on the same output key', () => {
  const rules = [
    { id: 'r1', when: { likely_subject: { in: ['unknown'] } }, then: { route_to_bucket: 'ephemera' } },
    { id: 'r2', when: { confidence: { below: 0.85 } }, then: { route_to_bucket: 'review' } },
  ];
  const { result, applied } = evaluateRules(rules, { likely_subject: 'unknown', confidence: 0 });
  assert.equal(result.route_to_bucket, 'review');
  assert.deepEqual(applied, ['r1', 'r2']);
});

test('evaluateRules: unsupported condition shapes do not match (rule silently skipped, not thrown)', () => {
  const rules = [{ id: 'r1', when: { formats: { one_of: [['jpg', 'tif']] } }, then: { role: 'archival_master' } }];
  const { applied } = evaluateRules(rules, { formats: 'jpg' });
  assert.deepEqual(applied, []);
});
const USB_SD_BIRDS_DIR = path.resolve(__dirname, '../pipelines/usb-sd-birds');

test('_readYaml: parses a real pipeline.yaml fixture', () => {
  const doc = PR._readYaml(path.join(USB_SD_BIRDS_DIR, 'pipeline.yaml'));
  assert.equal(doc.slug, 'usb-sd-birds');
  assert.ok(Array.isArray(doc.stages));
});

test('_readYaml: returns null for a missing file', () => {
  assert.equal(PR._readYaml(path.join(USB_SD_BIRDS_DIR, 'does-not-exist.yaml')), null);
});

test('_resolveRules: inlines all rule files into a flat rules array', () => {
  const pipelineDoc = PR._readYaml(path.join(USB_SD_BIRDS_DIR, 'pipeline.yaml'));
  const { rules, rule_sources } = PR._resolveRules(USB_SD_BIRDS_DIR, pipelineDoc.rules);

  assert.equal(rule_sources.length, 5);
  assert.ok(rules.length > 5); // multiple rules per file
  assert.ok(rules.some(r => r.id === 'all-media-is-classified'));
  assert.ok(rules.some(r => r.id === 'likely-bird-or-yard'));
});

test('_resolveRules: returns empty arrays when ruleRefs is not an array', () => {
  assert.deepEqual(PR._resolveRules(USB_SD_BIRDS_DIR, undefined), { rules: [], rule_sources: [] });
});

// ── WorkflowActions: _resolveHandler ─────────────────────────────────────────

test('WorkflowActions._resolveHandler: extracts .handler from an ACTION_REGISTRY entry', () => {
  const { _internals: WF } = require('../actions/WorkflowActions');
  const fn = async () => ({ data: {} });
  const registry = { 'artifact.create': { capability: 'artifact.write', handler: fn } };
  assert.equal(WF._resolveHandler(registry, 'artifact.create'), fn);
});

test('WorkflowActions._resolveHandler: returns null for an unregistered action', () => {
  const { _internals: WF } = require('../actions/WorkflowActions');
  assert.equal(WF._resolveHandler({}, 'does.not.exist'), null);
});

// ── TraceActions: _defaultCapabilities ───────────────────────────────────────

test('_defaultCapabilities: artifact.create grants read + write + create', () => {
  const caps = _defaultCapabilities('artifact', 'create');
  assert.ok(caps.includes('artifact.read'));
  assert.ok(caps.includes('artifact.write'));
  assert.ok(caps.includes('artifact.create'));
});

test('_defaultCapabilities: artifact.get grants only read', () => {
  const caps = _defaultCapabilities('artifact', 'get');
  assert.ok(caps.includes('artifact.read'));
  assert.ok(!caps.includes('artifact.write'));
});

test('_defaultCapabilities: template.list grants template.read', () => {
  const caps = _defaultCapabilities('template', 'list');
  assert.ok(caps.includes('template.read'));
});

test('_defaultCapabilities: unknown domain returns empty array', () => {
  assert.deepEqual(_defaultCapabilities('unknown', 'get'), []);
});

test('_defaultCapabilities: sync.push requires rank >= 100 (ADMIN) — granted at rank 100', () => {
  const caps = _defaultCapabilities('sync', 'push', 100);
  assert.ok(caps.includes('sync.write'));
});

test('_defaultCapabilities: sync.push denied below rank 100', () => {
  const caps = _defaultCapabilities('sync', 'push', 80);
  assert.ok(!caps.includes('sync.write'));
});

test('_defaultCapabilities: sync.push denied when rank is omitted entirely', () => {
  const caps = _defaultCapabilities('sync', 'push');
  assert.ok(!caps.includes('sync.write'));
});

test('_defaultCapabilities: rank does not affect capabilities with no rank floor', () => {
  const caps = _defaultCapabilities('artifact', 'get', 10);
  assert.ok(caps.includes('artifact.read'));
});

// ── TraceActions: verify ──────────────────────────────────────────────────────

const { verify, projectPayload, bindServices } = require('../actions/TraceActions');

test('verify: throws AUTH_NO_ROLE when role is missing (actor + tenant present)', async () => {
  await assert.rejects(
    () => verify({ user_id: 'u1', store_id: 's1' }, {}, {}),
    err => err.code === 'AUTH_NO_ROLE' && err.status === 401,
  );
});

test('verify: passes when actor, tenant, and role are all present', async () => {
  await assert.doesNotReject(() => verify({ user_id: 'u1', store_id: 's1', role: 'USER' }, {}, {}));
});

test('verify: ark_actor_id alone satisfies the actor check (no user_id needed)', async () => {
  await assert.doesNotReject(() => verify({ ark_actor_id: 'aa-1', store_id: 's1', role: 'owner' }, {}, {}));
});

test('verify: throws AUTH_NO_ACTOR when neither user_id nor ark_actor_id is present', async () => {
  await assert.rejects(
    () => verify({ store_id: 's1', role: 'owner' }, {}, {}),
    err => err.code === 'AUTH_NO_ACTOR',
  );
});

// ── TraceActions: projectPayload ──────────────────────────────────────────────

const _mockEp = (overrides = {}) => ({
  payload:      {},
  contract_def: null,
  trace:        { steps: [] },
  ...overrides,
});

test('projectPayload: no-op when contract has no fields', async () => {
  const result = await projectPayload({}, {}, _mockEp());
  assert.deepEqual(result, {});
});

test('projectPayload: projects declared fields from payload', async () => {
  const ep = _mockEp({
    payload:      { title: 'Hello', body: 'World', ignored: 'x' },
    contract_def: { fields: [{ key: 'title' }, { key: 'body' }] },
  });
  const result = await projectPayload({}, {}, ep);
  assert.deepEqual(result.payload, { title: 'Hello', body: 'World', ignored: 'x' });
});

// Regression: PCER.js's generic merge does Object.assign(ep, { payload: result.payload })
// — a full replacement of ep.payload, not a merge into it. Returning only the
// projected/declared fields here silently dropped every other payload key that a
// resolved template's `fields` array didn't happen to declare — confirmed live via
// dispatch: creating a Journal-templated Ark with a summary/is_arc set discarded both,
// since Journal's template only declares { title, body }. contract.fields describes the
// shape of entries captured *within* an ark of that type, not the shape of the
// ark.create/ark.update payload itself, which just happens to share the same resolved
// contract. Every real consumer downstream (ArkActions.*, ArtifactActions.*) already
// applies its own explicit allowlist, so this narrowing was never a security boundary.
test('projectPayload: undeclared payload keys survive (do not get silently dropped)', async () => {
  const ep = _mockEp({
    payload:      { title: 'Hello', summary: 'kept', is_arc: true },
    contract_def: { fields: [{ key: 'title' }] },
  });
  const result = await projectPayload({}, {}, ep);
  assert.deepEqual(result.payload, { title: 'Hello', summary: 'kept', is_arc: true });
});

test('projectPayload: throws 400 when required field is missing', async () => {
  const ep = _mockEp({
    payload:      { body: 'text' },
    contract_def: { fields: [{ key: 'title', required: true }, { key: 'body' }] },
  });
  await assert.rejects(
    () => projectPayload({}, {}, ep),
    err => err.status === 400 && err.code === 'PAYLOAD_INVALID',
  );
});

test('projectPayload: applies field default when value missing and not required', async () => {
  const ep = _mockEp({
    payload:      {},
    contract_def: { fields: [{ key: 'status', default: 'draft' }] },
  });
  const result = await projectPayload({}, {}, ep);
  assert.equal(result.payload.status, 'draft');
});

test('projectPayload: collects multiple missing-required errors in one throw', async () => {
  const ep = _mockEp({
    payload:      {},
    contract_def: { fields: [{ key: 'a', required: true }, { key: 'b', required: true }] },
  });
  await assert.rejects(
    () => projectPayload({}, {}, ep),
    err => err.message.includes('a') && err.message.includes('b'),
  );
});

// ── TraceActions: bindServices ────────────────────────────────────────────────

test('bindServices: no-op when contract declares no services', async () => {
  const result = await bindServices({}, {}, _mockEp());
  assert.deepEqual(result, {});
});

test('bindServices: no-op when contract scope has empty services array', async () => {
  const ep = _mockEp({ contract_def: { scope: { services: [] } } });
  const result = await bindServices({}, {}, ep);
  assert.deepEqual(result, {});
});

test('bindServices: returns {} when Manifest not configured (test env)', async () => {
  const ep = _mockEp({ contract_def: { scope: { services: ['storage'] } } });
  // Manifest not configured in tests — bindServices should return {} not throw
  const result = await bindServices({}, {}, ep);
  assert.ok(typeof result === 'object');
});

// ── TemplateResolver: contract schema — scope + execution_trace ───────────────

test('_emptyContract: has scope and execution_trace fields', () => {
  const c = _emptyContract();
  assert.ok('scope' in c);
  assert.ok('execution_trace' in c);
  assert.deepEqual(c.scope, {});
  assert.deepEqual(c.execution_trace, []);
});

test('_extractContract: reads scope from metadata', () => {
  const c = _extractContract({
    id: 'x',
    metadata: { scope: { services: ['storage', 'llm'], artifacts: 'current' } },
  });
  assert.deepEqual(c.scope.services, ['storage', 'llm']);
  assert.equal(c.scope.artifacts, 'current');
});

test('_extractContract: reads execution_trace from metadata', () => {
  const stage = { action: 'payload.project', response: { type: 'merge', payload: ['payload'] } };
  const c = _extractContract({ id: 'x', metadata: { execution_trace: [stage] } });
  assert.equal(c.execution_trace.length, 1);
  assert.equal(c.execution_trace[0].action, 'payload.project');
});

test('_merge: execution_trace concatenated from base then override', () => {
  const base     = { ..._emptyContract(), execution_trace: [{ action: 'a' }] };
  const override = { ..._emptyContract(), execution_trace: [{ action: 'b' }] };
  const merged   = _merge(base, override);
  assert.deepEqual(merged.execution_trace.map(s => s.action), ['a', 'b']);
});

test('_merge: scope deep-merged across composed contracts', () => {
  const base     = { ..._emptyContract(), scope: { services: ['storage'], artifacts: 'current' } };
  const override = { ..._emptyContract(), scope: { services: ['llm'], observers: true } };
  const merged   = _merge(base, override);
  // _deepMerge: override wins on scalar/array keys
  assert.deepEqual(merged.scope.services, ['llm']);
  assert.ok(merged.scope.observers);
  assert.equal(merged.scope.artifacts, 'current');
});

// ── PCER: _buildTraceList — 5 defaults ───────────────────────────────────────

test('_buildTraceList: includes all 6 default stages', () => {
  const stages  = _buildTraceList(null);
  const actions = stages.map(s => s.action);
  assert.ok(actions.includes('trace.open'));
  assert.ok(actions.includes('auth.verify'));
  assert.ok(actions.includes('ledger.open'));
  assert.ok(actions.includes('scope.resolve'));
  assert.ok(actions.includes('payload.project'));
  assert.ok(actions.includes('service.bind'));
  assert.equal(stages.length, 6);
});

test('_buildTraceList: ledger.open comes after auth.verify and before scope.resolve', () => {
  const stages  = _buildTraceList(null);
  const actions = stages.map(s => s.action);
  const authIdx   = actions.indexOf('auth.verify');
  const ledgerIdx = actions.indexOf('ledger.open');
  const scopeIdx  = actions.indexOf('scope.resolve');
  assert.ok(authIdx < ledgerIdx);
  assert.ok(ledgerIdx < scopeIdx);
});

test('_buildTraceList: contract execution_trace appended after all 6 defaults', () => {
  const contract = { execution_trace: [{ action: 'custom.stage' }] };
  const stages   = _buildTraceList(contract);
  assert.equal(stages[stages.length - 1].action, 'custom.stage');
  assert.equal(stages.length, 7);
});

// ── ArtifactLedger lifecycle ──────────────────────────────────────────────────

const ArtifactLedger = require('../domain/ArtifactLedger');

test('ArtifactLedger: has artifact_ledger table', () => {
  assert.equal(ArtifactLedger.table, 'artifact_ledger');
});

test('ArtifactLedger: close() assigns status closed + resolution', () => {
  const ledger = new ArtifactLedger({ id: 'l1' }, { context: { store_id: 's1' } });
  // Stub save to avoid DB
  ledger.save = async () => ledger;
  return ledger.close({ resolution: 'all_steps_completed', chain_id: null, execution_trace: [], duration_ms: 42 })
    .then(() => {
      assert.equal(ledger.get('status'), 'closed');
      assert.equal(ledger.get('resolution'), 'all_steps_completed');
      assert.equal(ledger.get('duration_ms'), 42);
      assert.ok(ledger.get('closed_at'));
    });
});

test('ArtifactLedger: error() assigns status error + error object', () => {
  const ledger = new ArtifactLedger({ id: 'l1' }, { context: { store_id: 's1' } });
  ledger.save = async () => ledger;
  const err = Object.assign(new Error('auth failed'), { code: 'AUTH_NO_ACTOR', pcer_stage: 'auth.verify' });
  return ledger.error(err, { execution_trace: [], duration_ms: 10 })
    .then(() => {
      assert.equal(ledger.get('status'), 'error');
      assert.equal(ledger.get('error').message, 'auth failed');
      assert.equal(ledger.get('error').code, 'AUTH_NO_ACTOR');
      assert.equal(ledger.get('error').pcer_stage, 'auth.verify');
    });
});

// ── ArtifactMedia: media fingerprint ─────────────────────────────────────────

const ArtifactMedia = require('../domain/ArtifactMedia');

test('ArtifactMedia: stores content_hash when provided', async () => {
  const media = new ArtifactMedia({ artifact_id: 'a1', content_hash: 'abc123' }, { context: {} });
  media.save = async () => media;
  await media.prepare();
  assert.equal(media.get('content_hash'), 'abc123');
});

test('ArtifactMedia: does not set content_hash when not provided', async () => {
  const media = new ArtifactMedia({ artifact_id: 'a1' }, { context: {} });
  media.save = async () => media;
  await media.prepare();
  assert.equal(media.get('content_hash'), null);
});

test('ArtifactMedia: content_hash is independent of packet fingerprint fields', async () => {
  // Media hash is over raw bytes — unaffected by title/body/metadata fields
  const media = new ArtifactMedia(
    { artifact_id: 'a1', content_hash: 'deadbeef', title: 'ignored', metadata: { x: 1 } },
    { context: {} },
  );
  media.save = async () => media;
  await media.prepare();
  assert.equal(media.get('content_hash'), 'deadbeef');
});

// ── _shapeEgress ──────────────────────────────────────────────────────────────

const { _shapeEgress } = require('../index');

test('_shapeEgress: artifact type extracts artifact and ark_id', () => {
  const data = { artifact: { id: 'a1', title: 'Test' }, ark_id: 'ark1', extra: 'ignored' };
  const shaped = _shapeEgress(data, 'artifact');
  assert.deepEqual(shaped, { artifact: { id: 'a1', title: 'Test' }, ark_id: 'ark1' });
});

test('_shapeEgress: artifact type sets ark_id to null when absent', () => {
  const shaped = _shapeEgress({ artifact: { id: 'a1' } }, 'artifact');
  assert.equal(shaped.ark_id, null);
});

test('_shapeEgress: packet type wraps data in packet key', () => {
  const data = { foo: 'bar' };
  const shaped = _shapeEgress(data, 'packet');
  assert.deepEqual(shaped, { packet: { foo: 'bar' } });
});

test('_shapeEgress: status type returns status and optional message', () => {
  assert.deepEqual(_shapeEgress({ status: 'ok', message: 'done' }, 'status'), { status: 'ok', message: 'done' });
  assert.deepEqual(_shapeEgress({ status: 'ok' }, 'status'), { status: 'ok' });
});

test('_shapeEgress: status type defaults status to ok when absent', () => {
  const shaped = _shapeEgress({}, 'status');
  assert.equal(shaped.status, 'ok');
});

test('_shapeEgress: composite returns data as-is', () => {
  const data = { a: 1, b: 2 };
  assert.deepEqual(_shapeEgress(data, 'composite'), data);
});

test('_shapeEgress: null type returns data as-is', () => {
  const data = { a: 1 };
  assert.deepEqual(_shapeEgress(data, null), data);
});

test('_shapeEgress: null data returns null', () => {
  assert.equal(_shapeEgress(null, 'artifact'), null);
});

// ── Phase 7: execution boundary invariants ────────────────────────────────────

test('CanonicalPacket: payload freeze prevents mutation', () => {
  const frozen = Object.freeze({ foo: 'bar' });
  assert.throws(() => { frozen.foo = 'changed'; }, { name: 'TypeError' });
});

test('CanonicalPacket: meta freeze prevents mutation', () => {
  const frozen = Object.freeze({ request_id: 'r1' });
  assert.throws(() => { frozen.request_id = 'changed'; }, { name: 'TypeError' });
});

test('_assertCapability: passes when capability is in ep.capabilities', () => {
  const ep = { capabilities: ['artifact.read', 'artifact.write'] };
  assert.doesNotThrow(() => _assertCapability(ep, 'artifact.read'));
});

test('_assertCapability: throws 403 when capability is absent', () => {
  const ep = { capabilities: ['artifact.read'] };
  assert.throws(
    () => _assertCapability(ep, 'artifact.archive'),
    (err) => err.status === 403 && err.code === 'CAPABILITY_DENIED',
  );
});

test('_assertCapability: passes when capability is null (unguarded action)', () => {
  const ep = { capabilities: [] };
  assert.doesNotThrow(() => _assertCapability(ep, null));
});

test('_assertCapability: throws when ep.capabilities is empty', () => {
  const ep = { capabilities: [] };
  assert.throws(
    () => _assertCapability(ep, 'artifact.write'),
    (err) => err.status === 403,
  );
});

test('scope: _emptyExecutionPacket has requested/granted/denied shape', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  assert.ok('requested' in ep.scope);
  assert.ok('granted'   in ep.scope);
  assert.ok('denied'    in ep.scope);
});

test('provenance.contract: has all required provenance fields', () => {
  const ep = _emptyExecutionPacket(_mockCanonical(), null, _mockCtx());
  const c  = ep.provenance.contract;
  assert.ok('template_id'           in c);
  assert.ok('template_slug'         in c);
  assert.ok('template_content_hash' in c);
  assert.ok('resolved_hash'         in c);
  assert.ok('composed_from'         in c);
  assert.ok('resolver_version'      in c);
});

test('_hashContract: returns a 64-char hex string for a contract', () => {
  const contract = { slug: 'test', fields: [], defaults: {} };
  const hash = _hashContract(contract);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test('_hashContract: same contract produces same hash', () => {
  const contract = { slug: 'test', fields: [], defaults: {} };
  assert.equal(_hashContract(contract), _hashContract(contract));
});

test('_hashContract: returns null for null input', () => {
  assert.equal(_hashContract(null), null);
});

test('provenance.contract: resolved_hash populated when contract provided', () => {
  const contract = { id: 'tmpl1', slug: 'note', fields: [], defaults: {}, scope: {}, response: {},
                     template_content_hash: 'abc', composed_from: [] };
  const ep = _emptyExecutionPacket(_mockCanonical(), contract, _mockCtx());
  assert.ok(ep.provenance.contract.resolved_hash !== null);
  assert.match(ep.provenance.contract.resolved_hash, /^[a-f0-9]{64}$/);
  assert.equal(ep.provenance.contract.template_slug, 'note');
  assert.equal(ep.provenance.contract.template_content_hash, 'abc');
  assert.deepEqual(ep.provenance.contract.composed_from, []);
});

// ── LLMAdapter ────────────────────────────────────────────────────────────────

test('LLMAdapter: instantiates with env defaults', () => {
  const adapter = new LLMAdapter();
  assert.equal(adapter.model,   process.env.OPENROUTER_MODEL || DEFAULT_MODEL);
  assert.equal(adapter.baseUrl, process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL);
  assert.equal(adapter.timeout, 60_000);
});

test('LLMAdapter: config overrides env', () => {
  const adapter = new LLMAdapter({ model: 'openai/gpt-4o', timeout: 30_000 });
  assert.equal(adapter.model, 'openai/gpt-4o');
  assert.equal(adapter.timeout, 30_000);
});

test('LLMAdapter: complete throws LLM_NOT_CONFIGURED when apiKey missing', async () => {
  const adapter = new LLMAdapter({ apiKey: null });
  // Temporarily clear key in case env has one
  const saved = adapter.apiKey;
  adapter.apiKey = null;
  await assert.rejects(
    () => adapter.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    err => err.code === 'LLM_NOT_CONFIGURED',
  );
  adapter.apiKey = saved;
});

test('LLMAdapter: complete throws LLM_INVALID_MESSAGES for empty messages', async () => {
  const adapter = new LLMAdapter({ apiKey: 'test-key' });
  await assert.rejects(
    () => adapter.complete({ messages: [] }),
    err => err.code === 'LLM_INVALID_MESSAGES',
  );
});

test('LLMAdapter: complete throws LLM_INVALID_MESSAGES for non-array messages', async () => {
  const adapter = new LLMAdapter({ apiKey: 'test-key' });
  await assert.rejects(
    () => adapter.complete({ messages: 'not an array' }),
    err => err.code === 'LLM_INVALID_MESSAGES',
  );
});

test('LLMAdapter: completeJSON is a function', () => {
  const adapter = new LLMAdapter();
  assert.equal(typeof adapter.completeJSON, 'function');
});

test('LLMAdapter: DEFAULT_MODEL is anthropic/claude-3.5-sonnet', () => {
  assert.equal(DEFAULT_MODEL, 'anthropic/claude-3.5-sonnet');
});

test('LLMAdapter: status() returns ok:false with error when apiKey missing', async () => {
  const adapter = new LLMAdapter({ apiKey: null });
  const result = await adapter.status();
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.model, adapter.model);
});

test('LLMAdapter: status() is a function separate from connect()', () => {
  const adapter = new LLMAdapter();
  assert.equal(typeof adapter.status,   'function');
  assert.equal(typeof adapter.connect,  'function');
  assert.notEqual(adapter.status, adapter.connect);
});

// ── chatParser ────────────────────────────────────────────────────────────────

// Fixture helpers
function _makeNode(id, parentId, role, text, ts) {
  return {
    id,
    parent: parentId,
    children: [],
    message: {
      id,
      author: { role },
      create_time: ts || 1700000000,
      content: { content_type: 'text', parts: [text] },
      status: 'finished_successfully',
    },
  };
}

function _makeConversation(id, title, nodeChain) {
  // nodeChain: [{ id, parentId, role, text }] in chronological order
  const mapping = {};
  for (let i = 0; i < nodeChain.length; i++) {
    const n = nodeChain[i];
    const parentId = i === 0 ? null : nodeChain[i - 1].id;
    mapping[n.id] = _makeNode(n.id, parentId, n.role, n.text, 1700000000 + i * 60);
    if (i > 0) mapping[nodeChain[i - 1].id].children.push(n.id);
  }
  const lastId = nodeChain[nodeChain.length - 1].id;
  return { id, title, create_time: 1700000000, mapping, current_node: lastId };
}

// Fixture A — single clean topic (3 messages)
const FIXTURE_A_CHAIN = [
  { id: 'msg-1', role: 'user',      text: 'What is PCER?' },
  { id: 'msg-2', role: 'assistant', text: 'PCER is the Pre-Contract Execution Resolver.' },
  { id: 'msg-3', role: 'user',      text: 'How does scope resolution work?' },
];
const FIXTURE_A = _makeConversation('conv-a', 'ARK Architecture', FIXTURE_A_CHAIN);

// Fixture G — duplicate detection
const FIXTURE_G = _makeConversation('conv-g', 'Duplicate Test', [
  { id: 'gm-1', role: 'user',      text: 'Hello' },
  { id: 'gm-2', role: 'assistant', text: 'Hi there' },
]);

// Fixture H — modified conversation (extra message added)
const FIXTURE_H_ORIGINAL = _makeConversation('conv-h', 'Incremental', [
  { id: 'hm-1', role: 'user',      text: 'First message' },
  { id: 'hm-2', role: 'assistant', text: 'First reply' },
]);
const FIXTURE_H_EXTENDED_CHAIN = [
  { id: 'hm-1', role: 'user',      text: 'First message' },
  { id: 'hm-2', role: 'assistant', text: 'First reply' },
  { id: 'hm-3', role: 'user',      text: 'New message added later' },
];
const FIXTURE_H_EXTENDED = _makeConversation('conv-h', 'Incremental', FIXTURE_H_EXTENDED_CHAIN);

// ── Parser: basic correctness ─────────────────────────────────────────────────

test('chatParser: parseConversation returns normalized structure', () => {
  const result = parseConversation(FIXTURE_A, 'chatgpt');
  assert.ok(result, 'result should not be null');
  assert.equal(result.source, 'chatgpt');
  assert.equal(result.title, 'ARK Architecture');
  assert.equal(result.id, 'conv-a');
});

test('chatParser: messages are in chronological order', () => {
  const result = parseConversation(FIXTURE_A, 'chatgpt');
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[1].role, 'assistant');
  assert.equal(result.messages[2].role, 'user');
});

test('chatParser: sequence numbers start at 0 and increment', () => {
  const result = parseConversation(FIXTURE_A, 'chatgpt');
  result.messages.forEach((m, i) => assert.equal(m.sequence, i));
});

test('chatParser: message bodies are preserved', () => {
  const result = parseConversation(FIXTURE_A, 'chatgpt');
  assert.equal(result.messages[0].body, 'What is PCER?');
  assert.equal(result.messages[1].body, 'PCER is the Pre-Contract Execution Resolver.');
});

test('chatParser: each message has a source_hash', () => {
  const result = parseConversation(FIXTURE_A, 'chatgpt');
  for (const msg of result.messages) {
    assert.match(msg.source_hash, /^[a-f0-9]{64}$/);
  }
});

test('chatParser: source_hash is stable across calls', () => {
  const r1 = parseConversation(FIXTURE_A, 'chatgpt');
  const r2 = parseConversation(FIXTURE_A, 'chatgpt');
  r1.messages.forEach((m, i) => assert.equal(m.source_hash, r2.messages[i].source_hash));
});

test('chatParser: parseExport handles an array input', () => {
  const results = parseExport([FIXTURE_A, FIXTURE_G], 'chatgpt');
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'conv-a');
  assert.equal(results[1].id, 'conv-g');
});

test('chatParser: parseExport handles single object input (not array)', () => {
  const results = parseExport(FIXTURE_A, 'chatgpt');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'conv-a');
});

test('chatParser: parseConversation returns null for malformed input', () => {
  assert.equal(parseConversation(null), null);
  assert.equal(parseConversation({}), null);
  assert.equal(parseConversation({ mapping: 'not-an-object' }), null);
});

test('chatParser: empty message parts are excluded', () => {
  const conv = _makeConversation('conv-empty', 'Empty', [
    { id: 'e1', role: 'user', text: '' },
    { id: 'e2', role: 'assistant', text: 'Real reply' },
  ]);
  const result = parseConversation(conv, 'chatgpt');
  // Empty-body message should be filtered out
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].body, 'Real reply');
});

// ── conversationHash: duplicate detection ─────────────────────────────────────

test('conversationHash: same messages produce same hash (Fixture G idempotency)', () => {
  const r1 = parseConversation(FIXTURE_G, 'chatgpt');
  const r2 = parseConversation(FIXTURE_G, 'chatgpt');
  assert.equal(conversationHash(r1.messages), conversationHash(r2.messages));
});

test('conversationHash: different conversations produce different hashes', () => {
  const ra = parseConversation(FIXTURE_A, 'chatgpt');
  const rg = parseConversation(FIXTURE_G, 'chatgpt');
  assert.notEqual(conversationHash(ra.messages), conversationHash(rg.messages));
});

test('conversationHash: extended conversation has different hash than original (Fixture H)', () => {
  const original = parseConversation(FIXTURE_H_ORIGINAL, 'chatgpt');
  const extended = parseConversation(FIXTURE_H_EXTENDED, 'chatgpt');
  assert.notEqual(conversationHash(original.messages), conversationHash(extended.messages));
});

test('conversationHash: original messages retain stable hashes after extension (Fixture H)', () => {
  const original = parseConversation(FIXTURE_H_ORIGINAL, 'chatgpt');
  const extended = parseConversation(FIXTURE_H_EXTENDED, 'chatgpt');
  // First two messages should have identical hashes in both versions
  assert.equal(original.messages[0].source_hash, extended.messages[0].source_hash);
  assert.equal(original.messages[1].source_hash, extended.messages[1].source_hash);
});

// ── _defaultCapabilities: chat domain ─────────────────────────────────────────

test('_defaultCapabilities: chat.import grants artifact.write and artifact.create', () => {
  const caps = _defaultCapabilities('chat', 'import');
  assert.ok(caps.includes('artifact.read'));
  assert.ok(caps.includes('artifact.write'));
  assert.ok(caps.includes('artifact.create'));
});

// ── dispatch: exported from ark/index.js ─────────────────────────────────────

test('dispatch: is a function', () => {
  assert.equal(typeof dispatch, 'function');
});

test('dispatch: throws MISSING_ACTION when action is omitted', async () => {
  try {
    await dispatch({}, { store_id: 1, user_id: null, source: 'test' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'MISSING_ACTION');
    assert.equal(err.status, 400);
  }
});

test('dispatch: throws UNKNOWN_ACTION for unregistered action', async () => {
  try {
    await dispatch({ action: 'does.not.exist' }, { store_id: 1, user_id: null, source: 'test' });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'UNKNOWN_ACTION');
    assert.equal(err.status, 404);
  }
});

test('REGISTRY: chat.import is registered with artifact.write capability', () => {
  assert.ok(REGISTRY['chat.import'], 'chat.import missing from registry');
  assert.equal(REGISTRY['chat.import'].capability, 'artifact.write');
  assert.equal(typeof REGISTRY['chat.import'].handler, 'function');
});

