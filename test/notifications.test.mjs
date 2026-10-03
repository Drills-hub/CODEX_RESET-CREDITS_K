import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderController } from '../public/notifications.mjs';

const hour = 3600000;
const snapshot = (credits = [{ number: 1, title: 'PRIVATE_TITLE', status: 'available', expiryState: 'known', grantedAt: 1, expiresAt: 100 * 3600 }], revision = 1) => ({ credits: credits.map(row => ({ reminderKey: testDigest(JSON.stringify([row.title, row.grantedAt])), ...row })), revision });
function testDigest(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `hash:${(hash >>> 0).toString(16)}`;
}
function harness({ now = 76 * hour, storage = new Map(), storageApi, lockState = new Map(), refresh = async value => value, digest = testDigest, permission = 'granted', NotificationClass } = {}) {
  const scheduled = [];
  const notices = [];
  const env = {
    now: () => now,
    setTimeout: (fn, delay) => { const timer = { fn, delay, cancelled: false }; scheduled.push(timer); return timer; },
    clearTimeout: timer => { timer.cancelled = true; },
    storage: storageApi ?? { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    locks: { request: (name, options, fn) => {
      const next = (lockState.get(name) ?? Promise.resolve()).then(fn);
      lockState.set(name, next.catch(() => {}));
      return next;
    } },
    Notification: Object.assign(NotificationClass ?? function (title, options) { notices.push({ title, options }); }, { get permission() { return permission; } }),
    crypto: { subtle: {}, digest },
  };
  const errors = [];
  const controller = createReminderController({ ...env, refresh, onError: error => errors.push(error) });
  return { controller, scheduled, notices, storage, errors, setNow: value => { now = value; } };
}

test('opt-in schedules only future 24h and 1h thresholds using one nearest timer', async () => {
  const h = harness({ now: 75 * hour });
  h.controller.enable();
  h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scheduled.filter(timer => !timer.cancelled).length, 1);
  assert.equal(h.scheduled.find(timer => !timer.cancelled).delay, hour);
});

test('a due reminder refreshes once, revalidates, and persists only hashed milestone metadata', async () => {
  let reads = 0;
  const h = harness({ now: 75 * hour, refresh: async value => { reads++; return value; } });
  h.controller.enable();
  h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.deepEqual(h.errors, []);
  assert.equal(h.notices.length, 1);
  const persisted = [...h.storage.values()].join('');
  assert.match(persisted, /hash:/);
  assert.match(persisted, /24h/);
  assert.doesNotMatch(persisted, /PRIVATE_TITLE|PRIVATE/);
  assert.doesNotMatch(h.notices[0].title + JSON.stringify(h.notices[0].options), /PRIVATE/);
});

test('late activation skips past thresholds and an ineligible refreshed item is not notified', async () => {
  const h = harness({ now: 98.5 * hour, refresh: async () => snapshot([{ number: 1, status: 'redeemed', expiryState: 'known', expiresAt: 100 * 3600 }]) });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scheduled.filter(timer => !timer.cancelled).length, 1);
  assert.equal(h.scheduled.find(timer => !timer.cancelled).delay, 30 * 60000);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 0);
});

test('failed refresh and denied permission leave the sent ledger unchanged', async () => {
  const h = harness({ refresh: async () => { throw new Error('offline'); } });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 0);
  assert.equal(h.storage.has('reset-check.reminders.sent.v1'), false);
});

test('ledger storage failure never emits a notification', async () => {
  const backing = new Map();
  const storageApi = {
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { if (key === 'reset-check.reminders.sent.v1') throw new Error('quota'); backing.set(key, value); },
    removeItem: key => backing.delete(key),
  };
  const h = harness({ now: 75 * hour, storageApi });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 0);
  assert.equal(backing.has('reset-check.reminders.sent.v1'), false);
});

test('notification construction failure rolls back its ledger entry', async () => {
  const NotificationClass = function () { throw new Error('notification unavailable'); };
  const h = harness({ now: 75 * hour, NotificationClass });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 0);
  assert.deepEqual(JSON.parse(h.storage.get('reset-check.reminders.sent.v1')), []);
});

test('refresh failure cancels the timer without disabling the opt-in', async () => {
  const h = harness({ now: 75 * hour, refresh: async () => { throw new Error('offline'); } });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.enabled, true);
  assert.equal(h.notices.length, 0);
});

test('pausing after a transient failure preserves the snapshot and replans', async () => {
  const h = harness({ now: 75 * hour });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.controller.pause();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.enabled, true);
  assert.equal(h.scheduled.filter(timer => !timer.cancelled).length, 1);
  assert.equal(h.scheduled.find(timer => !timer.cancelled).delay, hour);
});

test('opt-in preference restores from the same browser storage without exposing credit data', () => {
  const storage = new Map();
  const first = harness({ storage });
  assert.equal(first.controller.enable(), true);
  const second = harness({ storage });
  assert.equal(second.controller.restore(), true);
  assert.equal(storage.get('reset-check.reminders.enabled.v1'), 'true');
  assert.doesNotMatch(JSON.stringify([...storage.entries()]), /PRIVATE_TITLE|PRIVATE/);
});

test('account revision changes clear the sent ledger before replanning', () => {
  const storage = new Map([['reset-check.reminders.sent.v1', JSON.stringify([{ fingerprint: 'old', milestone: '1h', sentAt: 1 }])]]);
  const h = harness({ storage });
  h.controller.enable();
  h.controller.update(snapshot([], 1));
  h.controller.update(snapshot([], 2));
  assert.equal(storage.has('reset-check.reminders.sent.v1'), false);
});

test('account scope changes clear the sent ledger across controller restarts', () => {
  const storage = new Map([['reset-check.reminders.sent.v1', JSON.stringify([{ fingerprint: 'old', milestone: '1h', sentAt: 1 }])], ['reset-check.reminders.account-scope.v1', 'account-a']]);
  const h = harness({ storage });
  h.controller.update({ ...snapshot([], 1), accountScope: 'account-b' });
  assert.equal(storage.has('reset-check.reminders.sent.v1'), false);
  assert.equal(storage.get('reset-check.reminders.account-scope.v1'), 'account-b');
});

test('shared Web Lock prevents duplicate delivery across two controllers', async () => {
  const storage = new Map();
  const lockState = new Map();
  let reads = 0;
  const refresh = async value => { reads++; await new Promise(resolve => setImmediate(resolve)); return value; };
  const first = harness({ storage, lockState, now: 75 * hour, refresh });
  const second = harness({ storage, lockState, now: 75 * hour, refresh });
  first.controller.enable(); second.controller.enable();
  first.controller.update(snapshot()); second.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  first.setNow(76 * hour); second.setNow(76 * hour);
  await Promise.all(first.scheduled.filter(timer => !timer.cancelled).map(timer => timer.fn()).concat(second.scheduled.filter(timer => !timer.cancelled).map(timer => timer.fn())));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(first.notices.length + second.notices.length, 1);
});

test('cancelling while fingerprinting prevents a late notification', async () => {
  let release;
  let block = false;
  const digest = async value => block ? new Promise(resolve => { release = () => resolve(testDigest(value)); }) : testDigest(value);
  const h = harness({ now: 75 * hour, digest });
  h.controller.enable(); h.controller.update(snapshot());
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  block = true;
  const delivery = h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  h.controller.disable();
  release('hash:cancelled');
  await delivery;
  assert.equal(h.notices.length, 0);
});

test('same-time milestones for multiple credits are delivered from one refresh', async () => {
  let reads = 0;
  const credits = [
    { number: 1, title: 'one', status: 'available', expiryState: 'known', grantedAt: 1, expiresAt: 100 * 3600 },
    { number: 2, title: 'two', status: 'available', expiryState: 'known', grantedAt: 2, expiresAt: 100 * 3600 },
  ];
  const h = harness({ now: 75 * hour, refresh: async value => { reads++; return value; } });
  h.controller.enable(); h.controller.update(snapshot(credits));
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(h.notices.length, 2);
});

test('credit identity survives display ordinal changes', async () => {
  const target = { number: 2, title: 'target', status: 'available', expiryState: 'known', grantedAt: 2, expiresAt: 100 * 3600 };
  const h = harness({ now: 75 * hour, refresh: async () => snapshot([{ ...target, number: 1 }]) });
  h.controller.enable(); h.controller.update(snapshot([{ number: 1, title: 'removed', status: 'redeemed', expiryState: 'known', grantedAt: 1, expiresAt: 90 * 3600 }, target]));
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 1);
});

test('storage failure disables delivery and never emits a notification', () => {
  const storage = new Map();
  storage.set = () => { throw new Error('quota'); };
  const h = harness({ storage });
  assert.equal(h.controller.enable(), false);
  assert.equal(h.controller.enabled, false);
});

test('long waits are split below the browser timer maximum', async () => {
  let reads = 0;
  const h = harness({ now: 0, refresh: async value => { reads++; return value; } });
  h.controller.enable();
  h.controller.update(snapshot([{ number: 1, title: 'future', status: 'available', expiryState: 'known', grantedAt: 1, expiresAt: 10 * 365 * 24 * 3600 }]));
  await new Promise(resolve => setImmediate(resolve));
  const timer = h.scheduled.find(timer => !timer.cancelled);
  assert.ok(timer.delay <= 2147483647);
  await timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});

test('identical display fields with distinct stable keys produce two reminders', async () => {
  const row = snapshot().credits[0];
  const h = harness({ now: 75 * hour });
  h.controller.update(snapshot([{ ...row, reminderKey: 'first' }, { ...row, number: 2, reminderKey: 'second' }]));
  h.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 2);
});

test('replacement with identical display fields does not validate the old item', async () => {
  const row = snapshot().credits[0];
  const h = harness({ now: 75 * hour, refresh: async () => snapshot([{ ...row, reminderKey: 'replacement' }]) });
  h.controller.update(snapshot([{ ...row, reminderKey: 'original' }])); h.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(76 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.notices.length, 0);
});

test('turning off in a second tab prevents delivery by an already scheduled tab', async () => {
  const storage = new Map();
  const first = harness({ now: 75 * hour, storage });
  first.controller.update(snapshot()); first.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  const second = harness({ storage }); second.controller.restore(); second.controller.disable();
  first.setNow(76 * hour);
  await first.scheduled.find(timer => !timer.cancelled).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.notices.length, 0);
});

test('items without stable identifiers are displayed but never scheduled', async () => {
  const h = harness({ now: 75 * hour });
  h.controller.update({ ...snapshot(), credits: [{ ...snapshot().credits[0], reminderKey: undefined }] });
  h.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scheduled.length, 0);
});

test('an outdated asynchronous plan cannot recreate a cancelled timer', async () => {
  let release;
  const h = harness({ now: 75 * hour, digest: () => new Promise(resolve => { release = resolve; }) });
  h.controller.update(snapshot()); h.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  h.controller.update(snapshot([], 1));
  release('old-hash');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.scheduled.length, 0);
});

test('the 1h milestone refreshes once and denied permissions prevent opt-in', async () => {
  let reads = 0;
  const h = harness({ now: 98 * hour, refresh: async value => { reads++; return value; } });
  h.controller.update(snapshot()); h.controller.enable();
  await new Promise(resolve => setImmediate(resolve));
  h.setNow(99 * hour);
  await h.scheduled.find(timer => !timer.cancelled).fn();
  assert.equal(reads, 1);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0].options.body, /1시간/);
  const denied = harness({ permission: 'denied' });
  assert.equal(await denied.controller.requestEnable(), false);
  assert.equal(denied.storage.size, 0);
});
