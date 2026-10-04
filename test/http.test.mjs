import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApplication } from '../lib/http.mjs';
import { AppError } from '../lib/errors.mjs';
import { CreditService } from '../lib/service.mjs';
import { EventEmitter } from 'node:events';

async function setup(t, service) {
  const app = createApplication({ service: service ?? {
    status: async () => ({ connected: true, authState: 'chatgpt', revision: 0, busy: false }),
    read: async () => ({ queriedAt: 0, availableCount: 0, detailState: 'complete', credits: [], revision: 0 }),
  } });
  await app.listen(0);
  t.after(() => app.close());
  const url = app.origin;
  const response = await fetch(`${url}/api/session`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-Reset-Check': '1' }, body: JSON.stringify({ token: app.bootstrapToken }) });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  return { app, url, response, cookie, headers: { Origin: url, Cookie: cookie, 'X-Reset-Check': '1', 'Content-Type': 'application/json' } };
}
test('bootstrap requires a single-use token and sets a private session cookie', async t => {
  const { app, url, response } = await setup(t);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=604800/);
  const again = await fetch(`${url}/api/session`, { method: 'POST', headers: { Origin: url, 'X-Reset-Check': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.bootstrapToken }) });
  assert.equal(again.status, 403);
});
test('blocks unauthenticated and cross-origin API reads', async t => {
  const { url, headers } = await setup(t);
  assert.equal((await fetch(`${url}/api/status`)).status, 403);
  assert.equal((await fetch(`${url}/api/status`, { headers })).status, 200);
  for (const invalid of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'X-Reset-Check': '' }]) {
    assert.equal((await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers: { ...headers, ...invalid }, body: '{}' })).status, 403);
  }
  assert.equal((await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers: { ...headers, Origin: '' }, body: '{}' })).status, 403);
  const preflight = await fetch(`${url}/api/reset-credits/read`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('persisted browser session is renewed and cannot authenticate a different server run', async t => {
  const { url, cookie, headers } = await setup(t);
  const resumed = await fetch(`${url}/api/status`, { headers });
  assert.equal(resumed.status, 200);
  assert.match(resumed.headers.get('set-cookie'), /Max-Age=604800/);
  const other = await setup(t);
  const rejected = await fetch(`${other.url}/api/status`, { headers: { ...other.headers, Cookie: cookie } });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('set-cookie'), null);
});
test('rejects wrong Host, including DNS rebinding', async t => {
  const { url } = await setup(t);
  const result = await new Promise(resolve => {
    http.get(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(result, 403);
});
test('read endpoint returns no-store snapshots and rejects arbitrary bodies/RPC routes', async t => {
  const { url, headers } = await setup(t);
  const response = await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).availableCount, 0);
  assert.equal((await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers, body: '{"method":"account/rateLimitResetCredit/consume"}' })).status, 400);
  assert.equal((await fetch(`${url}/api/rpc`, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(`${url}/api/reset-credits/read`, { method: 'GET', headers })).status, 405);
  assert.equal((await fetch(`${url}/api/status?tab=forecast`, { headers })).status, 400);
});
test('static assets apply CSP and never expose project or auth files', async t => {
  const { url } = await setup(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url}/?tab=forecast&source=desktop`)).status, 200);
  assert.equal((await fetch(`${url}/tabs.mjs`)).status, 200);
  assert.equal((await fetch(`${url}/motion.mjs`)).status, 200);
  for (const path of ['/package.json', '/.codex/auth.json', '/lib/codex.mjs', '/missing']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404);
  }
});
test('unrecognized upstream errors never expose their raw text', async t => {
  const { url, headers } = await setup(t, { status: async () => ({}), read: async () => { throw new Error('SECRET_TOKEN SECRET_EMAIL'); } });
  const response = await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /SECRET/);
});
test('incompatible RPC results return only the sanitized error through service and HTTP', async t => {
  const client = new EventEmitter();
  client.request = async method => method === 'account/read'
    ? { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'PRIVATE_EMAIL' } }
    : { rateLimits: {}, rateLimitResetCredits: ['PRIVATE_PAYLOAD'] };
  const { url, headers } = await setup(t, new CreditService(client));
  const response = await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.code, 'INCOMPATIBLE');
  assert.match(payload.message, /Codex CLI.*최신 버전으로 업데이트/);
  assert.equal(payload.clearPrevious, false);
  assert.deepEqual(Object.keys(payload).sort(), ['clearPrevious', 'code', 'message']);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_EMAIL|PRIVATE_PAYLOAD/);
});
test('auth failures are actionable and rate timeout does not erase old data', async t => {
  const { url, headers } = await setup(t, { status: async () => ({}), read: async () => { throw new AppError('LOGIN_REQUIRED'); } });
  const response = await fetch(`${url}/api/reset-credits/read`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).clearPrevious, true);
});
