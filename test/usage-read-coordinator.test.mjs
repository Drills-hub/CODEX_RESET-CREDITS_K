import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageReadCoordinator } from '../public/usage-read-coordinator.mjs';

function broadcastHarness() {
  const peers = new Set();
  return class TestBroadcastChannel {
    constructor(name) { this.name = name; peers.add(this); }
    postMessage(data) { for (const peer of peers) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data: structuredClone(data) })); }
    close() { peers.delete(this); }
  };
}
function locksHarness() {
  let held = false;
  return { request: async (name, options, fn) => {
    if (options?.ifAvailable) {
      if (held) return fn(null);
      held = true; try { return await fn({ name }); } finally { held = false; }
    }
    while (held) await new Promise(resolve => setImmediate(resolve));
    held = true; try { return await fn({ name }); } finally { held = false; }
  } };
}
const snapshot = { queriedAt: 100, revision: 1, accountScope: 'digest', usageWindows: [] };
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.ok(predicate(), 'controller must reach the expected asynchronous state');
}

test('two tabs coalesce simultaneous reads and both receive the same snapshot', async () => {
  const locks = locksHarness(); const BroadcastChannel = broadcastHarness(); let reads = 0;
  const read = async () => { reads++; await new Promise(resolve => setImmediate(resolve)); return structuredClone(snapshot); };
  const first = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  const second = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  const [a, b] = await Promise.all([first.run(), second.run()]);
  assert.equal(reads, 1); assert.deepEqual(a, snapshot); assert.deepEqual(b, snapshot);
  first.close(); second.close();
});

test('a sanitized failure is shared without leaking arbitrary error fields', async () => {
  const locks = locksHarness(); const BroadcastChannel = broadcastHarness(); let reads = 0;
  const read = async () => { reads++; await new Promise(resolve => setImmediate(resolve)); throw Object.assign(new Error('safe message'), { code: 'TIMEOUT', clearPrevious: false, secret: 'PRIVATE_TOKEN' }); };
  const first = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  const second = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  const failures = await Promise.allSettled([first.run(), second.run()]);
  assert.equal(reads, 1);
  for (const failure of failures) {
    assert.equal(failure.status, 'rejected'); assert.equal(failure.reason.code, 'TIMEOUT');
    assert.doesNotMatch(JSON.stringify(failure.reason), /PRIVATE_TOKEN|secret/);
  }
  first.close(); second.close();
});

test('sanitized CLI and disconnection errors keep their actionable codes', async () => {
  for (const code of ['CLI_MISSING', 'DISCONNECTED', 'BAD_REQUEST']) {
    const coordinator = createUsageReadCoordinator({ read: async () => { throw { code, message: '정제된 오류 안내', clearPrevious: false }; } });
    await assert.rejects(coordinator.run(), error => error.code === code);
    coordinator.close();
  }
});

test('locks without a channel serialize reads and avoid BUSY overlap', async () => {
  const locks = locksHarness(); let active = 0; let reads = 0;
  const read = async () => { reads++; active++; assert.equal(active, 1); await new Promise(resolve => setImmediate(resolve)); active--; return snapshot; };
  const first = createUsageReadCoordinator({ locks, read });
  const second = createUsageReadCoordinator({ locks, read });
  await Promise.all([first.run(), second.run()]);
  assert.equal(reads, 2);
});

test('missing lock support retries BUSY once after 250ms', async () => {
  let reads = 0; const delays = [];
  const coordinator = createUsageReadCoordinator({ read: async () => {
    reads++; if (reads === 1) throw { code: 'BUSY', message: 'busy', clearPrevious: false }; return snapshot;
  }, setTimeout: (fn, delay) => { delays.push(delay); queueMicrotask(fn); return 1; }, clearTimeout: () => {} });
  assert.deepEqual(await coordinator.run(), snapshot);
  assert.equal(reads, 2); assert.deepEqual(delays, [250]);
});

test('close rejects broadcast waiters and ignores late results', async () => {
  const locks = locksHarness(); const BroadcastChannel = broadcastHarness(); let release;
  const first = createUsageReadCoordinator({ locks, BroadcastChannel, read: () => new Promise(resolve => { release = resolve; }) });
  const second = createUsageReadCoordinator({ locks, BroadcastChannel, read: async () => snapshot });
  const winner = first.run(); const waiter = second.run();
  await until(() => Boolean(release)); second.close();
  await assert.rejects(waiter, error => error.code === 'CONNECTION');
  release(snapshot); await winner;
  first.close();
});

test('closing a leader during its join delay releases the read lock', async () => {
  const locks = locksHarness(); const BroadcastChannel = broadcastHarness();
  const first = createUsageReadCoordinator({ locks, BroadcastChannel, read: async () => snapshot });
  const pending = first.run(); first.close();
  await assert.rejects(pending, error => error.code === 'CONNECTION');
  const second = createUsageReadCoordinator({ locks, BroadcastChannel, timeoutMs: 50, read: async () => snapshot });
  assert.deepEqual(await second.run(), snapshot);
  second.close();
});

test('a stalled leader times out waiters and later unrelated results are ignored', async () => {
  const BroadcastChannel = broadcastHarness();
  const controller = createUsageReadCoordinator({ BroadcastChannel, locks: { request: (name, options, fn) => options.ifAvailable ? fn(null) : new Promise(() => {}) }, timeoutMs: 5, read: async () => snapshot });
  await assert.rejects(controller.run(), error => error.code === 'TIMEOUT');
  controller.close();
});

test('join messages before asynchronous lock grants still receive the shared result', async () => {
  const base = locksHarness(); const BroadcastChannel = broadcastHarness(); let reads = 0;
  const locks = { request: (...args) => new Promise(resolve => setTimeout(() => resolve(base.request(...args)), 0)) };
  const read = async () => { reads++; return snapshot; };
  const a = createUsageReadCoordinator({ locks, BroadcastChannel, read, timeoutMs: 50 });
  const b = createUsageReadCoordinator({ locks, BroadcastChannel, read, timeoutMs: 50 });
  const results = await Promise.allSettled([a.run(), b.run()]);
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  assert.equal(reads, 1); a.close(); b.close();
});

test('exclusive fallback does not count queue time as a broadcast response timeout', async () => {
  const locks = locksHarness();
  const read = async () => { await new Promise(resolve => setTimeout(resolve, 15)); return snapshot; };
  const a = createUsageReadCoordinator({ locks, read, timeoutMs: 25 });
  const b = createUsageReadCoordinator({ locks, read, timeoutMs: 25 });
  const results = await Promise.allSettled([a.run(), b.run()]);
  assert.ok(results.every(result => result.status === 'fulfilled'), JSON.stringify(results));
  a.close(); b.close();
});

test('a new read in the same clock millisecond cannot reuse a completed peer result', async t => {
  const originalNow = Date.now; Date.now = () => 1000; t.after(() => { Date.now = originalNow; });
  const locks = locksHarness(); const BroadcastChannel = broadcastHarness(); let reads = 0;
  const read = async () => ({ ...snapshot, queriedAt: 100 + ++reads });
  const owner = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  const follower = createUsageReadCoordinator({ locks, BroadcastChannel, read });
  t.after(() => { owner.close(); follower.close(); });
  await Promise.all([owner.run(), follower.run()]); assert.equal(reads, 1);
  assert.equal((await follower.run()).queriedAt, 102);
  assert.equal(reads, 2);
});
