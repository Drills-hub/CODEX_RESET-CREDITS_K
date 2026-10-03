import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendUsage } from '../public/usage-timing.mjs';

const at = 1800000000;
function snapshot({ five = 65, weekly = 50, fiveIn = 7200, weekIn = 172800, allowed = true } = {}) {
  return { queriedAt: at, ordinaryUsageAllowed: allowed, usageWindows: [
    { kind: 'five-hour', windowDurationMins: 300, usedPercent: 100 - five, remainingPercent: five, resetsAt: at + fiveIn, state: 'complete' },
    { kind: 'weekly', windowDurationMins: 10080, usedPercent: 100 - weekly, remainingPercent: weekly, resetsAt: at + weekIn, state: 'complete' },
  ] };
}
const recommend = value => recommendUsage(value, { now: at * 1000 });

test('depleted windows recommend rechecking after the last depleted reset', () => {
  for (const [options, expected] of [
    [{ five: 0 }, at + 7200],
    [{ weekly: 0 }, at + 172800],
    [{ five: 0, weekly: 0 }, at + 172800],
    [{ five: 0, weekly: 0, fiveIn: 180000 }, at + 180000],
  ]) {
    const result = recommend(snapshot(options));
    assert.equal(result.code, 'exhausted');
    assert.equal(result.targetAt, expected);
    assert.match(result.title, /재조회/);
  }
});

test('weekly budget guard outranks the imminent five-hour reset', () => {
  const result = recommend(snapshot({ weekly: 20, fiveIn: 60, weekIn: 86401 }));
  assert.equal(result.code, 'weekly-budget');
  assert.equal(result.targetAt, at + 86401);
  assert.match(result.reason, /20%/);
  assert.equal(recommend(snapshot({ weekly: 21, fiveIn: 60, weekIn: 86401 })).code, 'five-hour-reset');
});

test('weekly reset at exactly 24 hours outranks the five-hour reset', () => {
  const result = recommend(snapshot({ weekly: 20, fiveIn: 3600, weekIn: 86400 }));
  assert.equal(result.code, 'weekly-reset');
  assert.equal(result.targetAt, at + 86400);
  assert.equal(recommend(snapshot({ weekIn: 86401 })).code, 'ready');
});

test('five-hour reset at exactly one hour recommends using the current allowance', () => {
  assert.equal(recommend(snapshot({ fiveIn: 3600 })).code, 'five-hour-reset');
  assert.equal(recommend(snapshot({ fiveIn: 3601 })).code, 'ready');
  assert.equal(recommend(snapshot({ fiveIn: 3600 })).targetAt, at + 3600);
});

test('ready recommendation reports the next reset without summing allowances', () => {
  const result = recommend(snapshot());
  assert.equal(result.code, 'ready');
  assert.equal(result.targetAt, at + 7200);
  assert.match(result.reason, /65%/);
  assert.match(result.reason, /50%/);
});

test('unknown server permission uses conditional copy and false permission blocks recommendations', () => {
  assert.match(recommend(snapshot({ allowed: null })).title, /잔여량 기준/);
  assert.equal(recommend(snapshot({ allowed: false })).code, 'server-restricted');
  assert.equal(recommend(snapshot({ allowed: false })).targetAt, null);
});

test('missing and invalid usage data never become a usable allowance', () => {
  assert.equal(recommend(null).code, 'not-ready');
  assert.equal(recommend({ queriedAt: at }).code, 'incomplete');
  for (const patch of [
    { state: 'partial' }, { state: 'invalid' }, { remainingPercent: null },
    { remainingPercent: -1 }, { remainingPercent: 101 }, { resetsAt: null },
  ]) {
    const value = snapshot();
    Object.assign(value.usageWindows[0], patch);
    assert.equal(recommend(value).code, 'incomplete');
  }
});

test('reset boundaries require requery rather than predicting replenishment', () => {
  for (const fiveIn of [0, -1]) assert.equal(recommend(snapshot({ fiveIn })).code, 'refresh-needed');
  assert.equal(recommend(snapshot({ weekIn: 0 })).code, 'refresh-needed');
  assert.equal(recommend(snapshot({ five: 0, fiveIn: 0 })).targetAt, null);
  assert.equal(recommend(snapshot({ fiveIn: 1 })).code, 'five-hour-reset');
});

test('failed reads keep recommendations suspended even when reset times are in the future', () => {
  const value = snapshot();
  assert.equal(recommendUsage(value, { now: at * 1000, stale: true }).code, 'refresh-needed');
  assert.equal(recommendUsage(value, { now: at * 1000, stale: false }).code, 'ready');
});
