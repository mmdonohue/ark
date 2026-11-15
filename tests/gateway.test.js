'use strict';

// `ark serve` gateway: a real HTTP server on loopback in front of dispatch()
// on a throwaway sqlite vessel. Needs local port binding.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrap, _reset } = require('../core/bootstrap');
const { dispatch } = require('../core/dispatch');
const { createGateway, READ_ACTIONS, WRITE_ACTIONS, DEFAULT_ACTIONS } = require('../cli/gateway');

const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-gateway-test-'));
const ADMIN = { ark_actor_id: 'actor-admin', store_id: 1, role: 'ADMIN', rank: 100, source: 'test' };
let gw;

before(async () => {
  _reset();
  await bootstrap({ db: { driver: 'sqlite', path: path.join(TMP, 'gw.sqlite') } });
  gw = await createGateway({
    dispatch, ctx: ADMIN, staticDir: path.resolve(__dirname, '../ui'),
    info: { vessel: 'test', actor: { display_name: 'tester', role: 'owner' } },
  });
});
after(() => gw?.close());

// Raw request so tests control Host/Origin exactly.
function req({ method = 'GET', path: p = '/', headers = {}, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: gw.port, method, path: p,
      headers: {
        host: `127.0.0.1:${gw.port}`,
        ...(auth ? { authorization: `Bearer ${gw.token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* static */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const action = (a, payload = {}, extra = {}) => req({ method: 'POST', path: '/api/action', body: { action: a, payload }, ...extra });

test('gateway: refuses to bind anything but loopback', async () => {
  await assert.rejects(createGateway({ dispatch, ctx: ADMIN, host: '0.0.0.0' }), /loopback only/);
});

test('gateway: /api needs the exact bearer token', async () => {
  assert.equal((await action('ark.list', {}, { auth: false })).status, 401);
  assert.equal((await action('ark.list', {}, { auth: false, headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await req({ path: '/api/health', auth: false })).status, 401);
});

test('gateway: foreign Host (DNS rebinding) and foreign Origin (CSRF) are refused', async () => {
  const rebound = await action('ark.list', {}, { headers: { host: `evil.example:${gw.port}` } });
  assert.equal(rebound.status, 421);
  const csrf = await action('ark.list', {}, { headers: { origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.json.error.code, 'BAD_ORIGIN');
  const same = await action('ark.list', {}, { headers: { origin: `http://127.0.0.1:${gw.port}` } });
  assert.equal(same.status, 200);
  assert.ok(!('access-control-allow-origin' in same.headers), 'never sends CORS headers');
});

test('gateway: only reads + the task lifecycle are exposed — other writes never reach dispatch', async () => {
  const before = await dispatch({ action: 'artifact.list', payload: { artifact_type: 'note' } }, ADMIN);
  const r = await action('artifact.create', { artifact_type: 'note', title: 'should not exist' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'ACTION_NOT_EXPOSED');
  const after = await dispatch({ action: 'artifact.list', payload: { artifact_type: 'note' } }, ADMIN);
  assert.equal(after.data.artifacts.length, before.data.artifacts.length);
  assert.ok(!READ_ACTIONS.some(a => /\.(create|update|archive|relate|run|watch|propose|push|complete_task|start|approve|complete)$/.test(a)));
  assert.deepEqual([...WRITE_ACTIONS], ['task.approve', 'task.complete']);
});

test('gateway: approve/complete go through dispatch; --read-only refuses them', async () => {
  const task = (await dispatch({ action: 'task.propose', payload: { title: 'from mission control' } }, ADMIN)).data.task;
  const approved = await action('task.approve', { task_id: task.id, note: 'go' });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.data.task.context.state, 'ready');
  const done = await action('task.complete', { task_id: task.id });
  assert.equal(done.json.data.task.context.state, 'resolved');
  assert.equal((await action('task.complete', { task_id: task.id })).status, 409);

  const ro = await createGateway({ dispatch, ctx: ADMIN, actions: READ_ACTIONS });
  try {
    const other = (await dispatch({ action: 'task.propose', payload: { title: 'read-only' } }, ADMIN)).data.task;
    const r = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: ro.port, method: 'POST', path: '/api/action',
        headers: { host: `127.0.0.1:${ro.port}`, authorization: `Bearer ${ro.token}`, 'content-type': 'application/json' } },
        res => { let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(raw) })); });
      rq.on('error', reject);
      rq.end(JSON.stringify({ action: 'task.approve', payload: { task_id: other.id } }));
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'ACTION_NOT_EXPOSED');
  } finally { await ro.close(); }
});

test('gateway: same envelope as Seravanna\'s /api/action, errors included', async () => {
  const ok = await action('ark.list');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.action, 'ark.list');
  assert.ok(Array.isArray(ok.json.data.arks));
  assert.ok(ok.json.meta.request_id);

  const missing = await action('ark.get', { ark_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.action, 'ark.get');
  assert.ok(missing.json.error.message);

  const bad = await req({ method: 'POST', path: '/api/action', body: '{nope' });
  assert.equal(bad.status, 400);
  const big = await req({ method: 'POST', path: '/api/action', body: JSON.stringify({ action: 'ark.list', payload: { pad: 'x'.repeat(70 * 1024) } }) });
  assert.equal(big.status, 413);
});

test('gateway: health reports vessel, actor and the exposed actions', async () => {
  const r = await req({ path: '/api/health' });
  assert.equal(r.status, 200);
  assert.equal(r.json.vessel, 'test');
  assert.deepEqual(r.json.actions, [...DEFAULT_ACTIONS]);
  assert.deepEqual(r.json.writes, [...WRITE_ACTIONS]);
});

test('gateway: serves the UI with a strict CSP and never escapes its directory', async () => {
  const index = await req({ path: '/', auth: false });
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(index.headers['x-frame-options'], 'DENY');
  assert.equal((await req({ path: '/app.js', auth: false })).status, 200);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/nope.js']) {
    assert.equal((await req({ path: p, auth: false })).status, 404, p);
  }
});

test('artifact.search: ark_id scopes to that Ark\'s members', async () => {
  const ark  = (await dispatch({ action: 'ark.create', payload: { title: 'Scoped' } }, ADMIN)).data.ark;
  const mine = (await dispatch({ action: 'artifact.create', payload: { artifact_type: 'task', title: 'in project', ark_id: ark.id } }, ADMIN)).data.artifact;
  await dispatch({ action: 'artifact.create', payload: { artifact_type: 'task', title: 'elsewhere' } }, ADMIN);

  const scoped = await action('artifact.search', { artifact_type: 'task', ark_id: ark.id });
  assert.deepEqual(scoped.json.data.artifacts.map(a => a.id), [mine.id]);

  const all = await action('artifact.search', { artifact_type: 'task' });
  assert.ok(all.json.data.artifacts.length >= 2);

  const empty = (await dispatch({ action: 'ark.create', payload: { title: 'Empty' } }, ADMIN)).data.ark;
  assert.deepEqual((await action('artifact.search', { ark_id: empty.id })).json.data.artifacts, []);

  const user = { ...ADMIN, ark_actor_id: 'u', role: 'USER', rank: 10 };
  await assert.rejects(dispatch({ action: 'artifact.search', payload: { ark_id: ark.id } }, user), err => err.status === 404);
});
