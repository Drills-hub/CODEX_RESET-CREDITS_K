import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from '../public/usage-timing.mjs';

const now = 1800000000;
const day = 86400;
function credit(number, deadlineIn, patch = {}) {
  return { number, title: `리셋권 ${number}`, status: 'available', expiryState: 'known',
    expiresAt: now + deadlineIn + 3600, resetType: 'codexRateLimits', ...patch };
}
function snapshot({ weekly = 50, five = 65, weekIn = 6 * day, fiveIn = 7200,
  credits = [credit(1, day), credit(2, 3 * day)], ...patch } = {}) {
  return { queriedAt: now, ordinaryUsageAllowed: true, availableCount: credits.length,
    detailState: 'complete', credits, usageWindows: [
      { kind: 'five-hour', state: 'complete', remainingPercent: five, resetsAt: now + fiveIn },
      { kind: 'weekly', state: 'complete', remainingPercent: weekly, resetsAt: now + weekIn },
    ], ...patch };
}
const plan = (value = snapshot(), options = {}) => timing.buildUsagePlan(value, { now, ...options });
const warnings = value => value.warnings.join(' ');
const expectedKeys = ['state', 'code', 'title', 'reason', 'queriedAt', 'targetAt',
  'requiredRatePerDay', 'ratePerDay', 'exhaustsAt', 'remainingAtTarget', 'rateSource',
  'coverage', 'firstCredit', 'nextCredit', 'firstUseAt', 'nextGapSeconds',
  'nextRequiredRatePerDay', 'nextRemainingPercent', 'events', 'segments', 'warnings'];

test('exports a pure plan builder with all fields even before the first read', () => {
  assert.equal(typeof timing.buildUsagePlan, 'function');
  const result = plan(null);
  assert.deepEqual(Object.keys(result).sort(), expectedKeys.sort());
  assert.equal(result.state, 'not-ready');
  for (const key of ['queriedAt', 'targetAt', 'requiredRatePerDay', 'ratePerDay',
    'exhaustsAt', 'remainingAtTarget', 'firstCredit', 'nextCredit', 'firstUseAt',
    'nextGapSeconds', 'nextRequiredRatePerDay', 'nextRemainingPercent']) assert.equal(result[key], null);
  assert.equal(result.coverage, 'unavailable');
  assert.equal(result.rateSource, 'auto');
  assert.deepEqual(result.segments, []);
});

test('depletion before the safety deadline uses depletion and the actual next deadline gap', () => {
  const result = plan(snapshot(), { ratePerDay: 100 });
  assert.equal(result.state, 'ready');
  assert.equal(result.queriedAt, now);
  assert.equal(result.targetAt, now + day);
  assert.equal(result.requiredRatePerDay, 50);
  assert.equal(result.ratePerDay, 100);
  assert.equal(result.exhaustsAt, now + day / 2);
  assert.equal(result.firstUseAt, now + day / 2);
  assert.equal(result.remainingAtTarget, 0);
  assert.equal(result.nextGapSeconds, 216000);
  assert.equal(result.nextRequiredRatePerDay, 40);
  assert.equal(result.nextRemainingPercent, 0);
  assert.match(result.reason, /소진.*재조회/);
  assert.match(warnings(result), /가정/);
  assert.match(warnings(result), /100%.*시나리오/);
  assert.deepEqual(result.segments, [
    { kind: 'estimate', fromAt: now, toAt: now + 43200, fromPercent: 50, toPercent: 0 },
    { kind: 'estimate', fromAt: now + 43200, toAt: now + day, fromPercent: 0, toPercent: 0 },
    { kind: 'scenario', fromAt: now + 43200, toAt: now + 129600, fromPercent: 100, toPercent: 0 },
    { kind: 'scenario', fromAt: now + 129600, toAt: now + 3 * day, fromPercent: 0, toPercent: 0 },
  ]);
});

test('slow depletion stops at the deadline and explains allowance sacrificed', () => {
  const result = plan(snapshot(), { ratePerDay: 10, rateSource: 'manual' });
  assert.equal(result.exhaustsAt, now + 5 * day);
  assert.equal(result.firstUseAt, now + day);
  assert.equal(result.remainingAtTarget, 40);
  assert.equal(result.nextGapSeconds, 2 * day);
  assert.equal(result.nextRequiredRatePerDay, 50);
  assert.equal(result.nextRemainingPercent, 80);
  assert.equal(result.rateSource, 'manual');
  assert.match(result.reason, /40%.*포기/);
});

test('visible leftover uses six significant digits without rounding numeric projections', () => {
  const result = plan(snapshot({ weekly: 80, credits: [credit(1, day - 3600), credit(2, 3 * day - 3600)] }), { ratePerDay: 40 });
  assert.match(result.reason, /예상 잔여 41\.6667%/);
  assert.doesNotMatch(result.reason, /41\.666666/);
  assert.equal(result.remainingAtTarget, 41.666666666666664);
  assert.equal(result.segments[0].toPercent, 41.666666666666664);
  assert.equal(result.nextGapSeconds, 172800);
  assert.equal(result.nextRemainingPercent, 20);

  const immediate = plan(snapshot({ five: 0, weekly: 80, credits: [credit(1, -1800)] }), { ratePerDay: 40 / 3,
    now: now + 1 });
  assert.match(immediate.reason, /예상 잔여 80%/);
  assert.equal(immediate.remainingAtTarget, 80);
});

test('natural weekly reset at or before the first deadline is the first target', () => {
  for (const weekIn of [day / 2, day]) {
    const result = plan(snapshot({ weekIn }), { ratePerDay: 100 });
    assert.equal(result.targetAt, now + weekIn);
    assert.equal(result.firstUseAt, null);
    assert.equal(result.nextGapSeconds, null);
    assert.equal(result.nextRequiredRatePerDay, null);
    assert.equal(result.nextRemainingPercent, null);
    assert.match(result.reason, /주간.*리셋.*재조회/);
    assert.equal(result.segments.some(row => row.kind === 'scenario'), false);
    assert.equal(result.events.some(row => row.kind === 'credit-use'), false);
  }
});

test('no rate gives a deadline rather than an invented depletion estimate or chart', () => {
  const result = plan();
  assert.equal(result.ratePerDay, null);
  assert.equal(result.exhaustsAt, null);
  assert.equal(result.remainingAtTarget, null);
  assert.equal(result.firstUseAt, now + day);
  assert.equal(result.nextGapSeconds, 2 * day);
  assert.equal(result.nextRequiredRatePerDay, 50);
  assert.equal(result.nextRemainingPercent, null);
  assert.match(result.reason, /마감/);
  assert.deepEqual(result.segments, []);
});

test('zero weekly balance remains a constrained ready plan and considers a credit now', () => {
  const result = plan(snapshot({ weekly: 0 }), { ratePerDay: 10 });
  assert.equal(result.state, 'ready');
  assert.equal(result.requiredRatePerDay, 0);
  assert.equal(result.exhaustsAt, now);
  assert.equal(result.firstUseAt, now);
  assert.equal(result.remainingAtTarget, 0);
  assert.match(warnings(result), /주간.*0%/);
  assert.doesNotMatch(result.title + result.reason, /지금 사용 가능|현재 사용 가능/);
});

test('five-hour exhaustion warns without asserting ordinary usage is allowed', () => {
  const result = plan(snapshot({ five: 0 }), { ratePerDay: 10 });
  assert.equal(result.state, 'ready');
  assert.match(warnings(result), /5시간.*0%/);
  assert.match(result.reason, /재조회/);
  assert.doesNotMatch(result.title + result.reason, /지금 사용 가능|현재 사용 가능/);
});

test('safety deadline inside one hour is immediate and never divides by zero', () => {
  for (const expiresIn of [1, 3599, 3600]) {
    const result = plan(snapshot({ credits: [credit(1, expiresIn - 3600)] }), { ratePerDay: 10 });
    assert.equal(result.targetAt, now);
    assert.equal(result.firstCredit.deadlineAt, now);
    assert.equal(result.firstUseAt, now);
    assert.equal(result.requiredRatePerDay, null);
    assert.equal(result.remainingAtTarget, 50);
    assert.match(warnings(result), /즉시/);
  }
});

test('same expiries warn even when early depletion makes a positive gap', () => {
  const value = snapshot({ credits: [credit(7, day), credit(2, day)] });
  const early = plan(value, { ratePerDay: 100 });
  assert.equal(early.firstCredit.number, 2);
  assert.equal(early.nextCredit.number, 7);
  assert.equal(early.nextGapSeconds, day / 2);
  assert.match(warnings(early), /동일.*만료/);
  const atDeadline = plan(value, { ratePerDay: 10 });
  assert.equal(atDeadline.nextGapSeconds, 0);
  assert.equal(atDeadline.nextRequiredRatePerDay, null);
  assert.equal(atDeadline.nextRemainingPercent, 100);
  assert.match(warnings(atDeadline), /간격.*0|동시/);
});

test('scenario stops at a known natural reset instead of projecting through it', () => {
  const result = plan(snapshot({ weekIn: 2 * day }), { ratePerDay: 10 });
  assert.equal(result.firstUseAt, now + day);
  assert.equal(result.nextGapSeconds, 2 * day);
  assert.equal(result.nextRequiredRatePerDay, null);
  assert.equal(result.nextRemainingPercent, null);
  assert.deepEqual(result.segments.filter(row => row.kind === 'scenario'), [
    { kind: 'scenario', fromAt: now + day, toAt: now + 2 * day, fromPercent: 100, toPercent: 90 },
  ]);
  assert.match(warnings(result), /주간.*리셋.*재조회/);
});

test('reset at the next deadline also requires requery, without guaranteeing that balance', () => {
  const result = plan(snapshot({ weekIn: 3 * day }), { ratePerDay: 10 });
  assert.equal(result.nextRequiredRatePerDay, null);
  assert.equal(result.nextRemainingPercent, null);
  assert.match(warnings(result), /재조회/);
});

test('unknown or missing reset effect omits refill numbers and scenario segments', () => {
  for (const resetType of ['unknown', undefined, 'arbitrary']) {
    const result = plan(snapshot({ credits: [credit(1, day, { resetType }), credit(2, 3 * day)] }), { ratePerDay: 10 });
    assert.equal(result.firstCredit.resetType, 'unknown');
    assert.equal(result.nextRequiredRatePerDay, null);
    assert.equal(result.nextRemainingPercent, null);
    assert.equal(result.segments.some(row => row.kind === 'scenario'), false);
    assert.match(warnings(result), /효과.*확인/);
  }
});

test('only known, future, available credits qualify and sorting does not infer eligibility from count', () => {
  const result = plan(snapshot({ availableCount: 99, credits: [
    credit(8, 3 * day), credit(3, day), credit(2, day),
    credit(1, 100, { status: 'redeeming' }), credit(4, 100, { status: 'redeemed' }),
    credit(5, 100, { expiryState: 'unknown' }), credit(6, 100, { expiresAt: null }),
    credit(9, -3600), credit(10, -3601), credit(11, 100, { expiresAt: Infinity }),
  ] }));
  assert.deepEqual(result.firstCredit, { number: 2, title: '리셋권 2',
    expiresAt: now + day + 3600, deadlineAt: now + day, resetType: 'codexRateLimits' });
  assert.equal(result.nextCredit.number, 3);
  assert.match(warnings(result), /만료.*제외/);
  assert.equal(result.events.filter(row => row.kind === 'credit-expiry').length, 2);
});

test('partial credit details explicitly limit the recommendation to observed entries', () => {
  const result = plan(snapshot({ detailState: 'partial', availableCount: 5 }));
  assert.equal(result.coverage, 'partial');
  assert.match(result.reason, /조회된 항목 중/);
  assert.match(warnings(result), /일부|부분/);
});

for (const detailState of ['unavailable', 'count-only']) {
  test(`${detailState} coverage never invents credit dates from a count or stray rows`, () => {
    const result = plan(snapshot({ detailState, availableCount: 99 }), { ratePerDay: 10 });
    assert.equal(result.state, 'ready');
    assert.equal(result.coverage, detailState);
    assert.equal(result.firstCredit, null);
    assert.equal(result.nextCredit, null);
    assert.equal(result.firstUseAt, null);
    assert.equal(result.targetAt, now + 6 * day);
    assert.match(warnings(result), /만료.*확인/);
  });
}

test('without eligible credits the weekly target retains existing conservation advice', () => {
  const result = plan(snapshot({ weekly: 20, credits: [] }), { ratePerDay: 10 });
  assert.equal(result.code, 'weekly-budget');
  assert.match(result.title, /필수/);
  assert.equal(result.targetAt, now + 6 * day);
  assert.equal(result.requiredRatePerDay, 20 / 6);
  assert.equal(result.firstUseAt, null);
  assert.equal(result.nextGapSeconds, null);
});

test('unknown permission makes credit advice conditional', () => {
  const result = plan(snapshot({ ordinaryUsageAllowed: null }), { ratePerDay: 10 });
  assert.equal(result.state, 'ready');
  assert.match(result.reason, /허용.*확인|가능.*경우/);
  assert.doesNotMatch(result.title, /지금 사용 가능합니다/);
});

const suspendedCases = [
  ['missing read', null, {}, 'not-ready'],
  ['refreshing', snapshot(), { refreshing: true }, 'refreshing'],
  ['stale', snapshot(), { stale: true }, 'refresh-needed'],
  ['future query', snapshot({ queriedAt: now + 1 }), {}, 'refresh-needed'],
  ['invalid query', snapshot({ queriedAt: NaN }), {}, 'refresh-needed'],
  ['negative query', snapshot({ queriedAt: -1 }), {}, 'refresh-needed'],
  ['invalid now', snapshot(), { now: NaN }, 'refresh-needed'],
  ['negative now', snapshot(), { now: -1 }, 'refresh-needed'],
  ['server blocked', snapshot({ ordinaryUsageAllowed: false }), {}, 'server-restricted'],
  ['five reset passed', snapshot({ fiveIn: 0 }), {}, 'refresh-needed'],
  ['weekly reset passed', snapshot({ weekIn: -1 }), {}, 'refresh-needed'],
  ['missing windows', snapshot({ usageWindows: [] }), {}, 'incomplete'],
  ['invalid reset', snapshot({ usageWindows: [{ kind: 'weekly', state: 'complete', remainingPercent: 50, resetsAt: Infinity }] }), {}, 'incomplete'],
];
for (const [name, value, options, state] of suspendedCases) {
  test(`${name} suspends all actionable projections`, () => {
    const result = plan(value, { ratePerDay: 10, ...options });
    assert.equal(result.state, state);
    assert.equal(result.targetAt, null);
    assert.equal(result.firstUseAt, null);
    assert.equal(result.exhaustsAt, null);
    assert.equal(result.nextRequiredRatePerDay, null);
    assert.deepEqual(result.segments, []);
    assert.equal(result.events.some(row => row.kind === 'credit-use'), false);
  });
}

test('invalid usage percentages and partial windows do not produce a plan', () => {
  for (const patch of [{ remainingPercent: -1 }, { remainingPercent: 101 },
    { remainingPercent: 1.5 }, { remainingPercent: null }, { state: 'partial' }, { resetsAt: null }]) {
    const value = snapshot();
    Object.assign(value.usageWindows[0], patch);
    assert.equal(plan(value).state, 'incomplete');
  }
});

test('invalid rates are unavailable, never silently coerced or used to divide', () => {
  for (const ratePerDay of [null, 0, -1, NaN, Infinity, -Infinity, '10', undefined]) {
    const result = plan(snapshot(), { ratePerDay, rateSource: 'manual' });
    assert.equal(result.ratePerDay, null);
    assert.equal(result.exhaustsAt, null);
    assert.equal(result.remainingAtTarget, null);
    assert.deepEqual(result.segments, []);
  }
  assert.equal(plan(snapshot(), { ratePerDay: 0.01 }).ratePerDay, 0.01);
});

test('events use seconds, distinguish assumptions, and preserve equal-time ordering', () => {
  const result = plan(snapshot({ weekly: 0, credits: [credit(1, day), credit(2, day)] }), { ratePerDay: 10 });
  assert.deepEqual(result.events.map(({ kind, at, creditNumber, assumed }) => ({ kind, at, creditNumber, assumed })), [
    { kind: 'now', at: now, creditNumber: null, assumed: false },
    { kind: 'credit-use', at: now, creditNumber: 1, assumed: true },
    { kind: 'credit-expiry', at: now + day + 3600, creditNumber: 1, assumed: false },
    { kind: 'credit-expiry', at: now + day + 3600, creditNumber: 2, assumed: false },
    { kind: 'weekly-reset', at: now + 6 * day, creditNumber: null, assumed: false },
  ]);
  assert.ok(result.events.every(row => typeof row.label === 'string' && row.label.length));
  assert.match(result.events.find(row => row.kind === 'credit-use').label, /검토|가정/);
});

test('all rates including extreme finite values keep output and chart geometry finite and bounded', () => {
  for (const ratePerDay of [Number.MIN_VALUE, 0.01, 10, 100, Number.MAX_VALUE]) {
    const result = plan(snapshot(), { ratePerDay });
    for (const key of ['queriedAt', 'targetAt', 'requiredRatePerDay', 'ratePerDay',
      'exhaustsAt', 'remainingAtTarget', 'firstUseAt', 'nextGapSeconds', 'nextRequiredRatePerDay', 'nextRemainingPercent']) {
      assert.ok(result[key] === null || Number.isFinite(result[key]), `${key}: ${result[key]}`);
    }
    for (const row of result.segments) {
      assert.ok(Number.isFinite(row.fromAt) && Number.isFinite(row.toAt));
      assert.ok(row.fromAt >= now && row.toAt >= row.fromAt);
      assert.ok(row.fromPercent >= 0 && row.fromPercent <= 100);
      assert.ok(row.toPercent >= 0 && row.toPercent <= 100);
    }
  }
});

test('deep-frozen input is unchanged and returned records do not alias snapshot rows', () => {
  const value = snapshot({ credits: [credit(2, 3 * day), credit(1, day)] });
  const before = structuredClone(value);
  for (const row of [...value.credits, ...value.usageWindows]) Object.freeze(row);
  Object.freeze(value.credits);
  Object.freeze(value.usageWindows);
  Object.freeze(value);
  const result = plan(value, { ratePerDay: 10 });
  assert.deepEqual(value, before);
  result.firstCredit.title = 'changed output';
  assert.deepEqual(value, before);
  assert.deepEqual(plan(value, { ratePerDay: 10 }), plan(value, { ratePerDay: 10 }));
});

test('coincident expiries still warn when the natural reset takes priority', () => {
  const result = plan(snapshot({ weekIn: day / 2, credits: [credit(1, day), credit(2, day)] }));
  assert.equal(result.firstUseAt, null);
  assert.match(warnings(result), /동일.*만료/);
});

test('weekly projections explain the separate five-hour restriction even with a positive balance', () => {
  const result = plan(snapshot({ five: 1 }), { ratePerDay: 100 });
  assert.equal(result.state, 'ready');
  assert.match(warnings(result), /5시간.*제한/);
});

test('malformed usage window collections suspend rather than throwing', () => {
  for (const usageWindows of [{}, 'weekly', [null], [null, ...snapshot().usageWindows]]) {
    const result = plan(snapshot({ usageWindows }));
    assert.equal(result.state, 'incomplete');
    assert.equal(result.targetAt, null);
    assert.deepEqual(result.segments, []);
  }
});

test('a depleted five-hour window still explains natural reset priority', () => {
  const result = plan(snapshot({ five: 0, weekIn: day / 2 }), { ratePerDay: 10 });
  assert.equal(result.firstUseAt, null);
  assert.match(result.reason, /주간.*리셋.*먼저/);
  assert.match(result.reason, /재조회/);
});

test('default now is converted to seconds and legacy advice remains milliseconds', t => {
  t.mock.method(Date, 'now', () => now * 1000);
  const result = timing.buildUsagePlan(snapshot(), { ratePerDay: 10 });
  assert.equal(result.events[0].at, now);
  assert.equal(result.targetAt, now + day);
  assert.equal(timing.recommendUsage(snapshot(), { now }).code, 'refresh-needed');
});

test('non-numeric now suspends projections before any millisecond coercion', () => {
  for (const invalidNow of ['1800000000', 1800000000n, new Number(now),
    { valueOf: () => now }, Symbol('now'), null, true]) {
    const result = plan(snapshot(), { now: invalidNow, ratePerDay: 10 });
    assert.equal(result.state, 'refresh-needed');
    for (const key of ['targetAt', 'requiredRatePerDay', 'exhaustsAt', 'remainingAtTarget',
      'firstUseAt', 'nextGapSeconds', 'nextRequiredRatePerDay', 'nextRemainingPercent', 'firstCredit', 'nextCredit']) {
      assert.equal(result[key], null, key);
    }
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.segments, []);
  }
});

test('five-hour exhaustion with expiry in thirty minutes keeps immediate review and sacrificed balance', () => {
  const result = plan(snapshot({ five: 0, fiveIn: 7200, credits: [credit(1, -1800)] }), { ratePerDay: 10 });
  assert.equal(result.state, 'ready');
  assert.equal(result.firstUseAt, now);
  assert.equal(result.remainingAtTarget, 50);
  assert.match(result.title, /즉시/);
  assert.match(result.reason, /즉시.*재조회.*리셋권.*검토/);
  assert.match(result.reason, /50%.*포기/);
  assert.match(result.reason, /5시간.*0%.*제한/);
  assert.doesNotMatch(result.reason, /리셋 시각 이후/);
  assert.doesNotMatch(result.title + result.reason, /지금 사용 가능|현재 사용 가능/);
});

test('five-hour exhaustion keeps later credit deadline and leftover advice conditional', () => {
  const result = plan(snapshot({ five: 0 }), { ratePerDay: 10 });
  assert.equal(result.firstUseAt, now + day);
  assert.equal(result.remainingAtTarget, 40);
  assert.match(result.reason, /안전 마감/);
  assert.match(result.reason, /40%.*포기/);
  assert.match(result.reason, /허용.*경우/);
  assert.match(result.reason, /5시간.*0%.*제한/);
});

test('without a rate an immediate credit deadline is retained despite both depleted windows', () => {
  const result = plan(snapshot({ five: 0, weekly: 0, detailState: 'partial', credits: [credit(1, -1800)] }));
  assert.equal(result.firstUseAt, now);
  assert.equal(result.exhaustsAt, null);
  assert.match(result.title, /즉시/);
  assert.match(result.reason, /안전 마감/);
  assert.match(result.reason, /즉시.*재조회.*리셋권.*검토/);
  assert.match(result.reason, /조회된 항목 중/);
  assert.match(result.reason, /소진 예상.*확인할 수 없/);
  assert.doesNotMatch(result.reason, /리셋 시각 이후/);
});
