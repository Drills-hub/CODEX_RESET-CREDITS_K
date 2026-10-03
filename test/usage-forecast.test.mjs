import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageHistory, createUsageForecastController } from '../public/usage-forecast.mjs';

const at = 1800000000;
function value(seconds, remaining, { reset = at + 18000, scope = 'synthetic-account', revision = 1, weekly = 50 } = {}) {
  return { queriedAt: seconds, accountScope: scope, revision, usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, remainingPercent: remaining, usedPercent: 100 - remaining, resetsAt: reset, state: 'complete' },
    { kind: 'weekly', windowDurationMins: 10080, remainingPercent: weekly, usedPercent: 100 - weekly, resetsAt: at + 604800, state: 'complete' },
  ] };
}
function history() {
  let time = at * 1000;
  const model = createUsageHistory({ now: () => time });
  return { model, add: (seconds, remaining, options) => { time = seconds * 1000; model.update(value(seconds, remaining, options)); },
    setNow: seconds => { time = seconds * 1000; }, read: () => model.read()[0] };
}

test('three successful samples derive independent window rates and depletion timestamps', () => {
  const h = history(); h.add(at, 100, { weekly: 50 }); h.add(at + 300, 90, { weekly: 49 });
  assert.equal(h.read().state, 'collecting');
  h.add(at + 600, 80, { weekly: 48 });
  assert.equal(h.read().state, 'forecast');
  assert.equal(h.read().ratePerHour, 120);
  assert.equal(h.read().exhaustsAt, at + 3000);
  assert.equal(h.model.read()[1].ratePerHour, 12);
  assert.equal(h.model.read()[1].exhaustsAt, at + 15000);
});

test('duplicate query seconds replace a sample instead of satisfying the three-sample minimum', () => {
  const h = history(); h.add(at, 100); h.add(at + 300, 90); h.add(at + 300, 80);
  assert.equal(h.read().samples, 2); assert.equal(h.read().state, 'collecting');
});

test('rolling thirty-minute history excludes older samples and stale idle forecasts', () => {
  const h = history(); h.add(at, 100); h.add(at + 300, 90); h.add(at + 600, 80);
  h.setNow(at + 1800); assert.equal(h.read().samples, 3);
  h.setNow(at + 1801); assert.equal(h.read().samples, 2); assert.equal(h.read().state, 'collecting');
  h.setNow(at + 2401); assert.equal(h.read().samples, 0);
});

test('no decrease, current depletion, and projections beyond reset have distinct states', () => {
  const flat = history(); flat.add(at, 100); flat.add(at + 300, 100); flat.add(at + 600, 100);
  assert.equal(flat.read().state, 'no-decrease'); assert.equal(flat.read().exhaustsAt, null);
  flat.add(at + 900, 0); assert.equal(flat.read().state, 'exhausted');
  const slow = history(); slow.add(at, 100, { reset: at + 3600 }); slow.add(at + 300, 99, { reset: at + 3600 }); slow.add(at + 600, 98, { reset: at + 3600 });
  assert.equal(slow.read().state, 'reset-first'); assert.equal(slow.read().ratePerHour, 12); assert.equal(slow.read().exhaustsAt, null);
});

test('reset, allowance increase, account switch, and missing fields discard incompatible history', () => {
  for (const options of [{ reset: at + 36000 }, { scope: 'next-account' }, { revision: 2 }]) {
    const h = history(); h.add(at, 100); h.add(at + 300, 90); h.add(at + 600, 80, options);
    assert.equal(h.read().samples, 1); assert.equal(h.read().state, 'collecting');
  }
  const h = history(); h.add(at, 100); h.add(at + 300, 90); h.add(at + 600, 95);
  assert.equal(h.read().samples, 1);
  h.model.update({ ...value(at + 600, 95), usageWindows: [] }); assert.equal(h.read().state, 'unavailable');
  h.model.update(undefined); assert.equal(h.read().samples, 0);
});

test('failed reads suspend extrapolation until a valid successful read and reset passage requires requery', () => {
  const h = history(); h.add(at, 100); h.add(at + 300, 90); h.add(at + 600, 80);
  h.model.pause(); assert.equal(h.read().state, 'stale'); assert.equal(h.read().exhaustsAt, null);
  h.add(at + 900, 70); assert.equal(h.read().state, 'forecast');
  h.setNow(at + 18000); assert.equal(h.read().state, 'reset-passed');
});

test('malformed percentages and future query times do not produce a rate', () => {
  const h = history();
  h.model.update(value(at + 100, 80)); assert.equal(h.read().state, 'unavailable');
  for (const remaining of [null, -1, 101, '20']) {
    h.model.update(value(at, remaining)); assert.equal(h.read().state, 'unavailable');
  }
});

function pollingHarness({ refresh } = {}) {
  let time = at * 1000; let visible = true; let latest = value(at, 100);
  let reads = 0; const timers = []; const changed = [];
  const controller = createUsageForecastController({ now: () => time, isVisible: () => visible,
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cancelled = true; },
    refresh: async () => { reads++; return refresh ? refresh() : latest; }, onChange: () => changed.push(true),
  });
  return { controller, timers, get reads() { return reads; }, setVisible: value => { visible = value; controller.visibilityChanged(); },
    setSnapshot: value => { latest = value; }, setNow: value => { time = value * 1000; },
    run: async () => { const timer = timers.find(row => !row.cancelled); assert.ok(timer); timer.cancelled = true; await timer.fn(); },
  };
}

test('forecast polling is opt-in, five-minute, visibility-aware and retains no disabled history', async () => {
  const h = pollingHarness(); h.controller.update(value(at, 100));
  assert.equal(h.timers.length, 0);
  h.controller.enable(); assert.equal(h.controller.read()[0].samples, 1);
  assert.equal(h.timers.find(row => !row.cancelled).delay, 300000);
  h.setNow(at + 300); h.setSnapshot(value(at + 300, 90)); await h.run();
  assert.equal(h.reads, 1); assert.equal(h.controller.read()[0].samples, 2);
  h.setVisible(false); assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
  h.setVisible(true); assert.equal(h.timers.find(row => !row.cancelled).delay, 300000);
  h.controller.disable(); assert.equal(h.controller.read()[0].samples, 0); assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
});

test('late in-flight polling after opt-out cannot repopulate history', async () => {
  let release;
  const h = pollingHarness({ refresh: () => new Promise(resolve => { release = resolve; }) });
  h.controller.update(value(at, 100)); h.controller.enable();
  h.setNow(at + 300); const work = h.run();
  h.controller.disable(); release(value(at + 300, 90)); await work;
  assert.equal(h.controller.read()[0].samples, 0);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
});

test('failure does not add samples and polling resumes at the next visible interval', async () => {
  let failed = true;
  const h = pollingHarness({ refresh: async () => { if (failed) throw new Error('offline'); return value(at + 600, 80); } });
  h.controller.update(value(at, 100)); h.controller.enable();
  h.setNow(at + 300); await h.run(); assert.equal(h.controller.read()[0].state, 'stale');
  assert.equal(h.controller.read()[0].samples, 1);
  assert.equal(h.timers.find(row => !row.cancelled).delay, 300000);
  failed = false; h.setNow(at + 600); await h.run(); assert.equal(h.controller.read()[0].samples, 2);
});

test('an account change during polling cannot be overwritten by the prior account result', async () => {
  let release;
  const h = pollingHarness({ refresh: () => new Promise(resolve => { release = resolve; }) });
  h.controller.update(value(at, 100)); h.controller.enable(); h.setNow(at + 300);
  const work = h.run();
  h.controller.update(value(at + 300, 90, { scope: 'next-account', reset: at + 36000 }));
  release(value(at + 300, 90)); await work;
  assert.equal(h.controller.read()[0].resetsAt, at + 36000);
  assert.equal(h.controller.read()[0].samples, 1);
});

test('a cancelled hidden-tab timer stays invalid after visibility returns', async () => {
  const h = pollingHarness(); h.controller.update(value(at, 100)); h.controller.enable();
  const cancelled = h.timers.find(row => !row.cancelled);
  h.setVisible(false); h.setVisible(true);
  await cancelled.fn(); assert.equal(h.reads, 0);
});

test('enabling a forecast after a failed read retains stale guidance until success', () => {
  const h = pollingHarness(); h.controller.update(value(at, 100)); h.controller.pause(); h.controller.enable();
  assert.equal(h.controller.read()[0].state, 'stale');
});

test('an elapsed estimate asks for requery instead of declaring real exhaustion', () => {
  const h = history(); h.add(at, 100); h.add(at + 300, 50); h.add(at + 600, 10);
  h.setNow(at + 680);
  assert.equal(h.read().state, 'estimate-passed');
  assert.equal(h.read().exhaustsAt, at + 667);
});

test('enabled visible polling starts without a successful initial snapshot', async () => {
  const h = pollingHarness(); h.controller.enable();
  assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
  h.setNow(at + 300); h.setSnapshot(value(at + 300, 90)); await h.run();
  assert.equal(h.reads, 1); assert.equal(h.controller.read()[0].samples, 1);
});

test('clearing account data preserves automatic recovery with an empty new history', async () => {
  const h = pollingHarness(); h.controller.update(value(at, 100)); h.controller.enable();
  h.controller.update(undefined);
  assert.equal(h.controller.read()[0].samples, 0);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
  h.setNow(at + 300); h.setSnapshot(value(at + 300, 90, { scope: 'next-account' })); await h.run();
  assert.equal(h.reads, 1); assert.equal(h.controller.read()[0].samples, 1);
});

test('repeated empty status updates do not postpone the initial automatic read', async () => {
  const h = pollingHarness(); h.controller.enable();
  const initial = h.timers.find(row => !row.cancelled); assert.ok(initial);
  h.setNow(at + 100); h.controller.update(undefined);
  h.setNow(at + 200); h.controller.update(undefined);
  h.setNow(at + 300); h.setSnapshot(value(at + 300, 90)); initial.cancelled = true; await initial.fn();
  assert.equal(h.reads, 1);
});

test('suspend preserves opt-in and history and resume restores exactly one timer', () => {
  const h = pollingHarness(); h.controller.update(value(at, 100)); h.controller.enable();
  h.setNow(at + 300); h.controller.update(value(at + 300, 90));
  h.setNow(at + 600); h.controller.update(value(at + 600, 80));
  h.controller.suspend();
  assert.equal(h.controller.enabled, true); assert.equal(h.controller.read()[0].samples, 3);
  assert.equal(h.controller.read()[0].state, 'forecast');
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
  h.controller.visibilityChanged(); h.controller.update(value(at + 600, 70));
  assert.equal(h.controller.read()[0].ratePerHour, 120);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
  h.controller.resume(); h.controller.resume();
  assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
  assert.equal(h.timers.find(row => !row.cancelled).delay, 300000);
});

test('a polling response after suspension cannot alter the retained history', async () => {
  let release;
  const h = pollingHarness({ refresh: () => new Promise(resolve => { release = resolve; }) });
  h.controller.update(value(at, 100)); h.controller.enable(); h.setNow(at + 300);
  const pending = h.run(); h.controller.suspend();
  release(value(at + 300, 90)); await pending;
  assert.equal(h.controller.read()[0].samples, 1);
  assert.equal(h.timers.filter(row => !row.cancelled).length, 0);
  h.controller.resume(); assert.equal(h.timers.filter(row => !row.cancelled).length, 1);
  h.controller.disable(); assert.equal(h.controller.enabled, false); assert.equal(h.controller.read()[0].samples, 0);
});
