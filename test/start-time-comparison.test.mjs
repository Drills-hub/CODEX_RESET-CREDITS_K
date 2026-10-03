import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStartTimes } from '../public/start-time-comparison.mjs';

const at = 1800000000;
function snapshot({ five = 65, weekly = 20, fiveReset = at + 3600, weekReset = at + 86400, allowed = true } = {}) {
  return { queriedAt: at, ordinaryUsageAllowed: allowed, usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, remainingPercent: five, usedPercent: 100 - five, resetsAt: fiveReset, state: 'complete' },
    { kind: 'weekly', windowDurationMins: 10080, remainingPercent: weekly, usedPercent: 100 - weekly, resetsAt: weekReset, state: 'complete' },
  ] };
}
const compare = value => compareStartTimes(value, { now: at * 1000 });

test('compares now and the two reported reset times without predicting future allowances', () => {
  const original = snapshot();
  const copy = structuredClone(original);
  const result = compare(original);
  assert.equal(result.state, 'complete'); assert.equal(result.queriedAt, at);
  assert.deepEqual(result.rows.map(row => [row.key, row.startAt]), [['now', at], ['five-hour', at + 3600], ['weekly', at + 86400]]);
  assert.deepEqual(result.rows.map(row => row.resetKinds), [[], ['five-hour'], ['five-hour', 'weekly']]);
  assert.deepEqual(result.rows[0].carriedLimits.map(row => [row.kind, row.remainingPercent]), [['five-hour', 65], ['weekly', 20]]);
  assert.deepEqual(result.rows[1].carriedLimits.map(row => [row.kind, row.remainingPercent]), [['weekly', 20]]);
  assert.deepEqual(result.rows[2].carriedLimits, []);
  assert.equal(result.rows[0].state, 'ready');
  assert.equal(result.rows[1].state, 'recheck'); assert.equal(result.rows[2].state, 'recheck');
  assert.deepEqual(original, copy);
});

test('a depleted weekly limit remains a relevant restriction after only the five-hour reset', () => {
  const result = compare(snapshot({ five: 0, weekly: 0 }));
  assert.equal(result.rows[0].state, 'exhausted');
  assert.equal(result.rows[1].state, 'remaining-limit');
  assert.match(result.rows[1].message, /주간.*0%/);
  assert.equal(result.rows[2].state, 'recheck');
  assert.doesNotMatch(result.rows[2].message, /사용 가능|100%/);
});

test('reversed reset order and equal reset timestamps do not assume weekly is later', () => {
  const reversed = compare(snapshot({ fiveReset: at + 86400, weekReset: at + 3600, five: 0 }));
  assert.deepEqual(reversed.rows[1].resetKinds, ['five-hour', 'weekly']);
  assert.deepEqual(reversed.rows[2].resetKinds, ['weekly']);
  assert.equal(reversed.rows[2].state, 'remaining-limit');
  assert.match(reversed.rows[2].message, /5시간.*0%/);
  const equal = compare(snapshot({ fiveReset: at + 3600, weekReset: at + 3600 }));
  assert.deepEqual(equal.rows[1].resetKinds, ['five-hour', 'weekly']);
  assert.deepEqual(equal.rows[2].resetKinds, ['five-hour', 'weekly']);
});

test('server restriction is preserved and unknown permission never claims current availability', () => {
  const restricted = compare(snapshot({ allowed: false }));
  assert.equal(restricted.rows[0].state, 'server-restricted');
  for (const row of restricted.rows) assert.match(row.message, /서버.*제한/);
  assert.equal(compare(snapshot({ allowed: null })).rows[0].state, 'conditional');
  assert.doesNotMatch(compare(snapshot({ allowed: null })).rows[0].message, /사용 가능/);
});

test('partial usage retains independently known reset times but never implies permission', () => {
  const value = snapshot();
  Object.assign(value.usageWindows[0], { state: 'partial', remainingPercent: null });
  const result = compare(value);
  assert.equal(result.state, 'incomplete');
  assert.equal(result.rows[1].startAt, at + 3600);
  assert.ok(result.rows.every(row => row.state === 'incomplete'));
  assert.equal(result.rows[0].carriedLimits[0].remainingPercent, null);
  const missing = compare({ ...value, usageWindows: [value.usageWindows[1]] });
  assert.equal(missing.rows[1].startAt, null);
  assert.equal(missing.rows[2].startAt, at + 86400);
});

test('missing and malformed windows are distinguished from a real zero allowance', () => {
  assert.equal(compare(null).state, 'not-ready');
  assert.equal(compare({ queriedAt: at }).state, 'incomplete');
  for (const patch of [{ remainingPercent: -1 }, { remainingPercent: 101 }, { remainingPercent: '20' }, { resetsAt: 'bad' }, { windowDurationMins: 60 }]) {
    const value = snapshot(); Object.assign(value.usageWindows[0], patch);
    assert.equal(compare(value).state, 'incomplete');
  }
  const duplicate = snapshot(); duplicate.usageWindows.push({ ...duplicate.usageWindows[0] });
  assert.equal(compare(duplicate).state, 'incomplete');
  assert.equal(compare({ queriedAt: at, usageWindows: {} }).state, 'incomplete');
});

test('expired reset or stale data requires requery rather than advancing reset cycles', () => {
  for (const value of [snapshot({ fiveReset: at }), snapshot({ weekReset: at - 1 })]) {
    const result = compare(value); assert.equal(result.state, 'refresh-needed');
    assert.ok(result.rows.every(row => row.state === 'refresh-needed' && row.startAt === null && !row.resetKinds.length));
  }
  assert.equal(compare(snapshot({ fiveReset: at + 1 })).state, 'complete');
  const stale = compareStartTimes(snapshot(), { now: at * 1000, stale: true });
  assert.equal(stale.state, 'refresh-needed'); assert.equal(stale.queriedAt, at);
  assert.ok(stale.rows.every(row => row.startAt === null));
});

test('invalid local clock or a query timestamp ahead of it cannot yield a comparison', () => {
  assert.equal(compareStartTimes(snapshot(), { now: NaN }).state, 'refresh-needed');
  assert.equal(compareStartTimes(snapshot(), { now: (at - 1) * 1000 }).state, 'refresh-needed');
});

test('refreshing preserves the query timestamp but suspends every decision row', () => {
  const result = compareStartTimes(snapshot(), { now: at * 1000, refreshing: true });
  assert.equal(result.state, 'refreshing');
  assert.equal(result.queriedAt, at);
  assert.ok(result.rows.every(row => row.state === 'refreshing' && row.startAt === null && row.resetKinds.length === 0));
  assert.ok(result.rows.every(row => !/사용 가능|활용 권장/.test(row.message)));
});
