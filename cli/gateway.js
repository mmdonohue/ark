'use strict';

// Local Mission Control gateway — `ark serve`.
//
// One governed route, POST /api/action, with the same request/response
// envelope as Seravanna's backend/routes/action.js, so a UI written against
// either is interchangeable. Plus GET /api/health and the static UI in ui/.
//
// Trust model: identical to the CLI. The actor is the vessel's local owner;
// the bearer token — not the role — is what stops another local process or
// a web page from using it. The action allowlist is a transport filter, not
// authority: dispatch() still runs PCER and the capability check.
//
//   - binds loopback only
//   - every /api/* request needs `Authorization: Bearer <token>`
//   - Host must be this gateway's own loopback address (DNS rebinding)
//   - an Origin header, if present, must be this gateway's origin (CSRF);
//     no CORS headers are ever sent
//   - reads + the task and event lifecycles + running approved tasks by
//     default; `ark serve --read-only` drops the writes. Nothing else that
//     writes is exposed.

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const READ_ACTIONS = Object.freeze([
  'artifact.list', 'artifact.get', 'artifact.search', 'artifact.events.list',
  'ark.list', 'ark.get', 'ark.graph',
  'template.list', 'template.get',
  'ledger.list', 'ledger.get',
  'chain.list', 'chain.get',
  'workflow.get',
  'harness.describe',
  'event.list',
  'task.scope',
]);

// Writes the local owner may make from Mission Control. Each is still a full
// dispatch() with its own rank floor (task.* / event.* / harness.* /
// repository.* / system.cycle = 100) and ledger entry. harness.run only runs
// a task that was approved, within the scope it was approved for.
const WRITE_ACTIONS = Object.freeze([
  'task.propose', 'task.revise', 'task.approve', 'task.complete',
  'harness.run', 'harness.cancel',
  'repository.add', 'repository.update', 'repository.remove',
  'event.create', 'event.update', 'event.pause', 'event.resume', 'event.cancel',
  'system.cycle',
]);
const DEFAULT_ACTIONS = Object.freeze([...READ_ACTIONS, ...WRITE_ACTIONS]);

const LOOPBACK  = new Set(['127.0.0.1', '::1', 'localhost']);
const BODY_CAP  = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options':        'DENY',
  'referrer-policy':        'no-referrer',
  'cache-control':          'no-store',
  // Artifact media may be remote (Supabase Storage) or inline data URLs.
  'content-security-policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'",
    "img-src 'self' data: blob: https:", "connect-src 'self'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; '),
};

function _send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function _fail(res, status, action, code, message) {
  _send(res, status, { ok: false, action: action || null, error: { code, message }, log: [], meta: {} });
}

async function createGateway({ dispatch, ctx, staticDir, info = {}, host = '127.0.0.1', port = 0, token, actions = DEFAULT_ACTIONS }) {
  if (!LOOPBACK.has(host)) throw new Error(`ark serve binds loopback only (got "${host}")`);
  token = token || crypto.randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const root = staticDir ? path.resolve(staticDir) : null;
  let allowedHosts = new Set();

  const authed = req => {
    const got = Buffer.from(req.headers.authorization || '');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };

  const server = http.createServer((req, res) => {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(hostHeader)) return _fail(res, 421, null, 'BAD_HOST', 'Unexpected Host header');
    if (req.headers.origin && req.headers.origin !== `http://${hostHeader}`) {
      return _fail(res, 403, null, 'BAD_ORIGIN', 'Cross-origin requests are not accepted');
    }

    const url = new URL(req.url, `http://${hostHeader}`);

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return _fail(res, 401, null, 'UNAUTHORIZED', 'Missing or invalid bearer token');

      if (url.pathname === '/api/health' && req.method === 'GET') {
        return _send(res, 200, { ok: true, ...info, actions, writes: actions.filter(a => !READ_ACTIONS.includes(a)) });
      }
      if (url.pathname !== '/api/action') return _fail(res, 404, null, 'NOT_FOUND', 'Not found');
      if (req.method !== 'POST') return _fail(res, 405, null, 'METHOD_NOT_ALLOWED', 'POST only');

      let raw = '';
      let tooBig = false;
      req.on('data', chunk => {
        if (tooBig) return;
        raw += chunk;
        if (raw.length > BODY_CAP) { tooBig = true; _fail(res, 413, null, 'BODY_TOO_LARGE', `Body over ${BODY_CAP} bytes`); req.destroy(); }
      });
      req.on('end', async () => {
        if (tooBig) return;
        let action, payload, meta;
        try { ({ action, payload = {}, meta = {} } = JSON.parse(raw || '{}')); }
        catch { return _fail(res, 400, null, 'INVALID_JSON', 'Body must be JSON'); }
        if (!action) return _fail(res, 400, null, 'MISSING_ACTION', 'action is required');
        if (!actions.includes(action)) {
          return _fail(res, 403, action, 'ACTION_NOT_EXPOSED', `${action} is not exposed by this gateway`);
        }
        try {
          const result = await dispatch(
            { action, payload, meta: { request_id: meta.request_id, source: 'mission-control' } },
            { ...ctx, source: 'mission-control' },
          );
          _send(res, 200, result);
        } catch (err) {
          _send(res, err.status || 500, {
            ok: false, action,
            error: { code: err.code || 'ACTION_ERROR', message: err.message },
            log: err._log || [], meta: {},
          });
        }
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return _fail(res, 405, null, 'METHOD_NOT_ALLOWED', 'GET only');
    if (!root) return _fail(res, 404, null, 'NOT_FOUND', 'No UI configured');

    const rel  = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return _fail(res, 404, null, 'NOT_FOUND', 'Not found');
    fs.readFile(file, (err, buf) => {
      if (err) return _fail(res, 404, null, 'NOT_FOUND', 'Not found');
      _send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  const shownHost = host === '::1' ? '[::1]' : host;
  allowedHosts = new Set([`${shownHost}:${actual}`, `localhost:${actual}`]);
  const url = `http://${shownHost}:${actual}`;

  return {
    url,
    token,
    port: actual,
    server,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { createGateway, READ_ACTIONS, WRITE_ACTIONS, DEFAULT_ACTIONS };
