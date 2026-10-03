import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, safeError } from './errors.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/notifications.mjs', ['notifications.mjs', 'text/javascript; charset=utf-8']],
  ['/time.mjs', ['time.mjs', 'text/javascript; charset=utf-8']],
  ['/state.mjs', ['state.mjs', 'text/javascript; charset=utf-8']],
  ['/usage-timing.mjs', ['usage-timing.mjs', 'text/javascript; charset=utf-8']],
  ['/usage-alerts.mjs', ['usage-alerts.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const sessionCookieMaxAge = 7 * 24 * 60 * 60;
function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function body(req) {
  if (req.headers['content-type'] !== 'application/json') return Promise.reject(new AppError('BAD_REQUEST'));
  return new Promise((resolve, reject) => {
    let text = ''; let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      text += chunk;
      if (Buffer.byteLength(text) > 2048) { tooLarge = true; reject(new AppError('BAD_REQUEST')); }
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new AppError('BAD_REQUEST')); }
    });
    req.on('error', () => reject(new AppError('BAD_REQUEST')));
    req.on('aborted', () => reject(new AppError('BAD_REQUEST')));
  });
}
export function createApplication({ service } = {}) {
  let session = null; let cookieName = null;
  const app = { origin: '', bootstrapToken: randomBytes(32).toString('base64url') };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== app.origin.slice(7) || (req.headers.origin !== undefined && req.headers.origin !== app.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('FORBIDDEN');
      const path = req.url;
      if (path.startsWith('/api/')) {
        if (req.headers['x-reset-check'] !== '1') throw new AppError('FORBIDDEN');
        if (req.method !== 'GET' && req.headers.origin !== app.origin) throw new AppError('FORBIDDEN');
        if (path === '/api/session') {
          if (req.method !== 'POST') { json(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
          const data = await body(req);
          if (!matches(data.token, app.bootstrapToken) || Object.keys(data).length !== 1) throw new AppError('FORBIDDEN');
          // Consume before responding; parallel exchanges cannot reuse the token.
          app.bootstrapToken = null;
          session = randomBytes(32).toString('base64url');
          res.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${sessionCookieMaxAge}`);
          json(200, { ok: true }); return;
        }
        const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
        if (!matches(cookie, session)) throw new AppError('FORBIDDEN');
        res.setHeader('Set-Cookie', `${cookieName}=${session}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${sessionCookieMaxAge}`);
        if (path === '/api/status') {
          if (req.method !== 'GET') { json(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
          // Status polling observes locally confirmed events; it never polls OpenAI usage.
          json(200, await service.status({ refresh: false })); return;
        }
        if (path === '/api/reset-credits/read') {
          if (req.method !== 'POST') { json(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
          if (Object.keys(await body(req)).length !== 0) throw new AppError('BAD_REQUEST');
          json(200, await service.read()); return;
        }
        json(404, { code: 'NOT_FOUND' }); return;
      }
      const asset = assets.get(path);
      if (!asset) { json(404, { code: 'NOT_FOUND' }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(405, { code: 'METHOD_NOT_ALLOWED' }); return; }
      const bytes = await readFile(new URL(`../public/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (raw) {
      const error = safeError(raw);
      const statuses = { FORBIDDEN: 403, BAD_REQUEST: 400, LOGIN_REQUIRED: 401, AUTH_UNSUPPORTED: 401, ACCOUNT_CHANGED: 409, BUSY: 409, TIMEOUT: 504 };
      json(statuses[error.code] ?? 502, { code: error.code, message: error.message, clearPrevious: ['LOGIN_REQUIRED', 'AUTH_UNSUPPORTED', 'ACCOUNT_CHANGED'].includes(error.code) });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  app.listen = async (port = 0) => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    app.origin = `http://127.0.0.1:${server.address().port}`;
    cookieName = `reset_check_${server.address().port}`;
  };
  app.close = async () => {
    session = null; app.bootstrapToken = null;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return app;
}
