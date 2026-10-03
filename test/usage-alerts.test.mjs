import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageAlertController } from '../public/usage-alerts.mjs';
import { webcrypto } from 'node:crypto';

const minute = 60000;
const at = 1800000000000;
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.ok(predicate(), 'asynchronous controller planning must finish');
}
function value({ remaining = 65, reset = at / 1000 + 3600, revision = 1, scope = 'synthetic-account-digest' } = {}) {
  return { queriedAt: at / 1000, revision, accountScope: scope, usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, remainingPercent: remaining, usedPercent: 100 - remaining, resetsAt: reset, state: 'complete' },
  ] };
}
function harness({ shared = new Map(), lockState = new Map(), refresh, permission = 'granted', NotificationClass, storageApi } = {}) {
  let time = at;
  const timers = []; const notices = []; const errors = [];
  const storage = storageApi ?? { getItem: key => shared.get(key) ?? null, setItem: (key, text) => shared.set(key, text), removeItem: key => shared.delete(key) };
  const locks = { request: (name, options, fn) => {
    const work = (lockState.get(name) ?? Promise.resolve()).then(fn);
    lockState.set(name, work.catch(() => {}));
    return work;
  } };
  const Notification = Object.assign(NotificationClass ?? function (title, options) { notices.push({ title, ...options }); }, { permission, requestPermission: async () => permission });
  let latest = value(); let reads = 0;
  const controller = createUsageAlertController({ storage, locks, crypto: webcrypto, Notification,
    now: () => time, setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cancelled = true; },
    refresh: async () => { reads++; return refresh ? refresh() : latest; }, onError: error => errors.push(error),
  });
  return { controller, timers, notices, errors, shared, get reads() { return reads; },
    update: next => { latest = next; controller.update(next); }, setNow: next => { time = next; },
    run: async () => { await until(() => timers.some(row => !row.cancelled)); const timer = timers.find(row => !row.cancelled); timer.cancelled = true; await timer.fn(); },
  };
}

test('opt-in alone schedules the next reset threshold and revalidates before notifying', async () => {
  const h = harness(); h.update(value());
  assert.equal(h.timers.length, 0);
  assert.equal(await h.controller.requestEnable(), true);
  assert.equal(h.timers.find(row => !row.cancelled).delay, 30 * minute);
  h.setNow(at + 30 * minute); await h.run();
  assert.equal(h.reads, 1); assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].body, /30분/);
});

test('low allowance is alerted once per window after a fresh validation', async () => {
  const h = harness(); h.update(value({ remaining: 20 }));
  await h.controller.requestEnable(); await h.run();
  assert.equal(h.notices.length, 1); assert.match(h.notices[0].body, /20%/);
  h.update(value({ remaining: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.timers.filter(row => !row.cancelled).every(row => row.delay > 0));
  const persisted = [...h.shared.values()].join('');
  assert.doesNotMatch(persisted, /remainingPercent|usedPercent|resetsAt/);
});

test('changed or missing fresh data and a different account prevent delivery', async () => {
  for (const fresh of [value({ remaining: 60 }), { ...value(), usageWindows: [] }, value({ remaining: 20, scope: 'other-account' }), null]) {
    const h = harness({ refresh: async () => fresh }); h.update(value({ remaining: 20 }));
    await h.controller.requestEnable(); await h.run();
    assert.equal(h.notices.length, 0);
  }
});

test('reset notification requires an observed timestamp transition after the old reset', async () => {
  let latest = value();
  const h = harness({ refresh: async () => latest }); h.update(latest);
  await h.controller.requestEnable();
  h.setNow(at + 30 * minute); await h.run();
  h.setNow(at + 60 * minute);
  latest = value({ reset: at / 1000 + 21600, remaining: 90 });
  await h.run();
  assert.equal(h.notices.length, 2); assert.match(h.notices[1].body, /리셋.*확인/);
  assert.doesNotMatch(h.notices[1].body, /사용 가능|100%/);
});

test('unchanged expired window retries later instead of claiming replenishment', async () => {
  const h = harness(); h.update(value({ reset: at / 1000 + 60 }));
  await h.controller.requestEnable(); await h.run();
  h.setNow(at + minute); await h.run();
  assert.equal(h.notices.filter(row => /갱신이 확인/.test(row.body)).length, 0);
  assert.equal(h.timers.find(row => !row.cancelled).delay, minute);
});

test('two tabs share one ledger and a shared opt-out cancels delivery', async () => {
  const shared = new Map(); const lockState = new Map();
  const a = harness({ shared, lockState }); const b = harness({ shared, lockState });
  a.update(value({ remaining: 20 })); b.update(value({ remaining: 20 }));
  await a.controller.requestEnable(); b.controller.restore();
  await Promise.all([a.run(), b.run()]);
  assert.equal(a.notices.length + b.notices.length, 1);
  a.controller.disable(); b.setNow(at + 30 * minute); await b.run();
  assert.equal(a.notices.length + b.notices.length, 1);
});

test('disable or account change during the verification prevents a late notification', async () => {
  for (const action of ['disable', 'account']) {
    let release;
    const h = harness({ refresh: () => new Promise(resolve => { release = resolve; }) });
    h.update(value({ remaining: 20 })); await h.controller.requestEnable();
    const work = h.run(); await new Promise(resolve => setImmediate(resolve));
    if (action === 'disable') h.controller.disable();
    else h.update(value({ scope: 'another-account', revision: 2 }));
    release(value({ remaining: 20 })); await work;
    assert.equal(h.notices.length, 0);
  }
});

test('denied permission or missing account scope never produces alerts', async () => {
  const denied = harness({ permission: 'denied' }); denied.update(value());
  assert.equal(await denied.controller.requestEnable(), false);
  const missing = harness(); missing.update(value({ scope: '' })); await missing.controller.requestEnable();
  assert.equal(missing.timers.filter(row => !row.cancelled).length, 0);
});

test('failed refresh pauses timers until a new successful usage snapshot', async () => {
  const h = harness({ refresh: async () => { throw new Error('offline'); } });
  h.update(value({ remaining: 20 })); await h.controller.requestEnable(); await h.run();
  assert.equal(h.notices.length, 0);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
  assert.equal(h.controller.enabled, true);
  h.update(value()); await until(() => h.timers.some(row => !row.cancelled));
  assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
});

test('ledger failure stops notification and constructor failure rolls back delivery', async () => {
  const shared = new Map();
  const storageApi = { getItem: key => shared.get(key) ?? null, removeItem: key => shared.delete(key),
    setItem: (key, value) => { if (key.includes('.sent.')) throw new Error('quota'); shared.set(key, value); } };
  const h = harness({ storageApi }); h.update(value({ remaining: 20 })); await h.controller.requestEnable(); await h.run();
  assert.equal(h.notices.length, 0);
  const broken = harness({ NotificationClass: function () { throw new Error('blocked'); } });
  broken.update(value({ remaining: 20 })); await broken.controller.requestEnable(); await broken.run();
  assert.deepEqual(JSON.parse(broken.shared.get('reset-check.usage-alerts.sent.v1')), []);
});

test('a new account confirmed during delivery receives its own future schedule', async () => {
  let release;
  const h = harness({ refresh: () => new Promise(resolve => { release = resolve; }) });
  h.update(value({ remaining: 20 })); await h.controller.requestEnable();
  const work = h.run(); await until(() => Boolean(release));
  h.update(value({ scope: 'new-account', revision: 2 }));
  release(value({ remaining: 20 })); await work;
  assert.equal(h.notices.length, 0);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
  assert.equal(h.timers.find(row => !row.cancelled).delay, 30 * minute);
});

test('an app-dispatched update during verification still emits one validated alert', async () => {
  const fresh = value({ remaining: 20 });
  const h = harness({ refresh: async () => { h.update(fresh); return fresh; } });
  h.update(fresh); await h.controller.requestEnable(); await h.run();
  assert.equal(h.notices.length, 1);
  assert.equal(h.reads, 1);
});

test('one tab clearing its snapshot preserves same-account delivery records for other tabs', async () => {
  const shared = new Map(); const lockState = new Map();
  const a = harness({ shared, lockState }); const b = harness({ shared, lockState });
  a.update(value({ remaining: 20 })); b.update(value({ remaining: 20 }));
  await a.controller.requestEnable(); await a.run();
  assert.equal(a.notices.length, 1);
  b.controller.update(undefined);
  assert.ok(shared.has('reset-check.usage-alerts.sent.v1'));
  b.update(value({ remaining: 20, revision: 2 }));
  a.update(value({ remaining: 20 })); await a.controller.requestEnable();
  assert.ok(a.timers.filter(row => !row.cancelled).every(row => row.delay > 0));
  assert.equal(a.notices.length, 1);
});

test('missing reset verification data suspends pending transitions without a zero-delay loop', async () => {
  const h = harness({ refresh: async () => ({ ...value(), usageWindows: [] }) });
  h.update(value({ reset: at / 1000 + 60 }));
  h.setNow(at + minute);
  h.update(value({ reset: at / 1000 + 18000 }));
  await h.controller.requestEnable(); await h.run();
  assert.equal(h.reads, 1); assert.equal(h.notices.length, 0);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
});
