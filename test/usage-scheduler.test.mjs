import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Missing module is caught only to make the first RED an actual assertion.
const engine = await import('../public/usage-scheduler.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const N = 1800000000, H = 3600;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const slot = (start, end) => ({ startAt: N + start * H, endAt: N + end * H });
const credit = (number, deadline, patch = {}) => ({ number, title: `리셋권 ${number}`,
  status: 'available', expiryState: 'known', expiresAt: N + (deadline + 1) * H,
  resetType: 'codexRateLimits', ...patch });
function snapshot({ weekly = 50, five = 100, week = 100, fiveReset = 100,
  credits = [credit(1, 4), credit(2, 8)], ...patch } = {}) {
  return { queriedAt: N, ordinaryUsageAllowed: true, detailState: 'complete',
    availableCount: credits.length, credits, usageWindows: [
      { kind: 'weekly', state: 'complete', remainingPercent: weekly, resetsAt: N + week * H },
      { kind: 'five-hour', state: 'complete', remainingPercent: five, resetsAt: N + fiveReset * H },
    ], ...patch };
}
const sample = (seconds, weeklyRemaining, patch = {}) => ({ at: N + seconds,
  weeklyRemaining, fiveRemaining: 80 - seconds / 60, weeklyResetsAt: N + 100 * H,
  fiveResetsAt: N + H, accountScope: 'scope', revision: 1, activeSession: 1, ...patch });
const estimate = rows => engine.estimateConsumption(rows, { now: N + 600 });

test('exports the six pure scheduler entry points', () => {
  for (const key of ['parseKstInput', 'normalizeWorkSlots', 'estimateConsumption',
    'simulateUsage', 'chooseRedemptionPlan', 'buildWorkSchedulePlan']) assert.equal(typeof engine[key], 'function', key);
});
test('KST datetime parsing uses UTC+09 including seconds and leap day', () => {
  assert.equal(engine.parseKstInput('1970-01-01T09:00'), 0);
  assert.equal(engine.parseKstInput('2024-02-29T09:00:01'), 1709164801);
  assert.equal(engine.parseKstInput('2026-10-04T00:00'), 1791039600);
});
test('KST parsing is identical under UTC, Seoul and American daylight-saving time zones', () => {
  const moduleUrl = new URL('../public/usage-scheduler.mjs', import.meta.url).href;
  for (const TZ of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const m = await import(process.argv[1]); process.stdout.write(String(m.parseKstInput("2024-03-10T09:30")));', moduleUrl],
    { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '1710030600');
  }
});
test('KST parser rejects rollover, bad formats, nonstrings and pre-epoch times', () => {
  for (const value of [null, 1, '', '2023-02-29T09:00', '2024-04-31T09:00',
    '2024-01-01T24:00', '2024-01-01T09:60', '2024-01-01T09:00:60',
    '2024-01-01T09:00Z', '1970-01-01T00:00', '0000-01-01T09:00']) assert.equal(engine.parseKstInput(value), null);
});
test('work slots clip, merge touching/overlap, sort and preserve input', () => {
  const rows = [slot(4, 8), slot(-1, 2), slot(1, 4), slot(9, 10), { startAt: NaN, endAt: N }];
  const copy = structuredClone(rows);
  assert.deepEqual(engine.normalizeWorkSlots(rows, { now: N, until: N + 9 * H }), [slot(0, 8)]);
  assert.deepEqual(rows, copy);
});
test('slot normalization safely rejects excess and invalid bounds', () => {
  assert.deepEqual(engine.normalizeWorkSlots(Array.from({ length: 33 }, () => slot(0, 1))), []);
  assert.deepEqual(engine.normalizeWorkSlots([slot(0, 1)], { now: NaN }), []);
  assert.deepEqual(engine.normalizeWorkSlots([{ startAt: N + 0.5, endAt: N + H },
    { startAt: -1, endAt: N }, slot(2, 1)]), []);
});
test('active-session estimator weights elapsed seconds rather than averaging interval rates', () => {
  const result = estimate([sample(0, 90), sample(60, 88), sample(600, 80)]);
  assert.deepEqual(result, { state: 'ready', weeklyPerHour: 60, fiveHourPerHour: 60, samples: 3 });
});
test('duplicate timestamps replace evidence and never count as three observations', () => {
  assert.equal(estimate([sample(0, 90), sample(0, 89), sample(600, 80)]).state, 'collecting');
  near(estimate([sample(0, 90), sample(60, 89), sample(60, 88), sample(600, 80)]).weeklyPerHour, 60);
});
test('session, scope, revision, increase, invalidity and backwards clock break contiguous evidence', () => {
  for (const patch of [{ activeSession: 2 }, { activeSession: null }, { accountScope: 'other' },
    { revision: 2 }, { weeklyResetsAt: N + 200 * H }, { weeklyRemaining: 95 },
    { weeklyRemaining: NaN }, { fiveRemaining: null }, { at: N - 1 }]) {
    assert.notEqual(estimate([sample(0, 90), sample(60, 89), sample(120, 88, patch), sample(600, 80)]).state, 'ready');
  }
});
test('recent verified suffix can recover after a broken session', () => {
  assert.equal(estimate([sample(0, 95, { activeSession: null }), sample(60, 90), sample(120, 89), sample(600, 80)]).state, 'ready');
});
test('old/future evidence is unusable and flat weekly observations do not invent a rate', () => {
  assert.equal(estimate([sample(-1300, 95), sample(60, 90), sample(600, 80)]).state, 'collecting');
  assert.equal(estimate([sample(0, 90), sample(60, 89), sample(601, 88)]).state, 'unavailable');
  assert.equal(estimate([sample(0, 90), sample(60, 90), sample(600, 90)]).state, 'no-decrease');
  assert.deepEqual(estimate([]), { state: 'unavailable', weeklyPerHour: null, fiveHourPerHour: null, samples: 0 });
});
test('five-hour reset or increase suppresses its rate while preserving verified weekly evidence', () => {
  for (const patch of [{ fiveResetsAt: N + 2 * H }, { fiveRemaining: 90 }]) {
    const result = estimate([sample(0, 90), sample(60, 89), sample(600, 80, patch)]);
    assert.equal(result.state, 'ready');
    assert.equal(result.fiveHourPerHour, null);
  }
});
test('flat five-hour readings remain unknown when weekly measurements decrease', () => {
  assert.equal(estimate([sample(0, 90, { fiveRemaining: 80 }), sample(60, 89, { fiveRemaining: 80 }),
    sample(600, 80, { fiveRemaining: 80 })]).fiveHourPerHour, null);
});

const simulate = (value = snapshot(), slots = [slot(0, 8)], reviews = [], options = {}) => {
  assert.equal(typeof engine.simulateUsage, 'function', 'simulation export required');
  return engine.simulateUsage(value, slots, reviews, { now: N, weeklyPerHour: 20, ...options });
};
const review = (number, hours) => ({ number, at: N + hours * H });
function finiteTree(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), String(value));
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteTree);
}
test('simulation consumes only active work, keeps sleep flat and splits depletion', () => {
  const result = simulate(snapshot({ weekly: 50 }), [slot(0, 1), slot(5, 8)]);
  assert.equal(result.state, 'ready');
  near(result.metrics.totalUsedPercent, 50);
  near(result.metrics.blockedWorkHours, 1.5);
  assert.deepEqual(result.segments, [
    { kind: 'estimate', fromAt: N, toAt: N + H, fromPercent: 50, toPercent: 30 },
    { kind: 'estimate', fromAt: N + H, toAt: N + 5 * H, fromPercent: 30, toPercent: 30 },
    { kind: 'estimate', fromAt: N + 5 * H, toAt: N + 6.5 * H, fromPercent: 30, toPercent: 0 },
    { kind: 'estimate', fromAt: N + 6.5 * H, toAt: N + 8 * H, fromPercent: 0, toPercent: 0 },
  ]);
  assert.match(result.warnings.join(' '), /5시간.*알 수|5시간.*미확인/);
});
test('weekly totals can exceed 100 across two proposed refills with separate discarded amounts', () => {
  const result = simulate(snapshot({ weekly: 50 }), [slot(0, 8)], [review(1, 2), review(2, 6)]);
  near(result.metrics.totalUsedPercent, 160);
  near(result.metrics.totalDiscardedPercent, 30);
  near(result.metrics.firstRemainingPercent, 10);
  near(result.metrics.nextRemainingPercent, 20);
  assert.equal(result.metrics.expiredCredits, 0);
  assert.equal(result.events.filter(e => e.kind === 'credit-use').length, 2);
  assert.ok(result.events.filter(e => e.kind === 'credit-use').every(e => e.assumed && /검토.*재조회|재조회.*검토/.test(e.label)));
  assert.ok(result.segments.filter(s => s.fromAt >= N + 2 * H).every(s => s.kind === 'scenario'));
});
test('each first provided natural reset discards/refills once and never invents recurrence', () => {
  const result = simulate(snapshot({ weekly: 80, week: 2, fiveReset: 3 }), [slot(0, 8)], [review(1, 4)], { fiveHourPerHour: 10 });
  near(result.metrics.totalUsedPercent, 160);
  near(result.metrics.totalDiscardedPercent, 100);
  assert.equal(result.events.filter(e => e.kind === 'weekly-reset').length, 1);
  assert.equal(result.events.filter(e => e.kind === 'five-hour-reset').length, 1);
  assert.ok(result.events.filter(e => /reset/.test(e.kind)).every(e => e.assumed && /가정|시나리오/.test(e.label)));
  assert.equal(result.metrics.expiredCredits, 1);
});
test('known five-hour bottleneck consumes independent units and blocks both budgets at depletion', () => {
  const result = simulate(snapshot({ weekly: 100, five: 10 }), [slot(0, 2)], [], { fiveHourPerHour: 40 });
  near(result.metrics.totalUsedPercent, 5);
  near(result.metrics.blockedWorkHours, 1.75);
  assert.equal(result.segments[0].toPercent, 95);
});
test('zero five-hour rate does not block a positive budget; actual zero does block', () => {
  near(simulate(snapshot({ five: 10 }), [slot(0, 1)], [], { fiveHourPerHour: 0 }).metrics.totalUsedPercent, 20);
  for (const rate of [0, null, 20]) {
    const result = simulate(snapshot({ five: 0, fiveReset: 1 }), [slot(0, 2)], [], { fiveHourPerHour: rate });
    near(result.metrics.totalUsedPercent, 20);
    near(result.metrics.blockedWorkHours, 1);
  }
});
test('known credit refill of five-hour budget is explicitly hypothetical', () => {
  const result = simulate(snapshot({ weekly: 100, five: 10 }), [slot(0, 2)], [review(1, 1)], { fiveHourPerHour: 40 });
  near(result.metrics.totalUsedPercent, 25);
  near(result.metrics.totalDiscardedPercent, 95);
  assert.match(result.warnings.join(' '), /5시간.*100%.*가정/);
});
test('unknown five-hour rate never converts weekly units or assumes five-hour credit restoration', () => {
  const result = simulate(snapshot({ weekly: 100, five: 0 }), [slot(0, 2)], [review(1, 1)]);
  near(result.metrics.totalUsedPercent, 0);
  near(result.metrics.blockedWorkHours, 2);
});
test('unknown credit effect stops projections at review without inventing a second refill', () => {
  const result = simulate(snapshot({ credits: [credit(1, 4, { resetType: 'unknown' }), credit(2, 8)] }),
    [slot(0, 8)], [review(1, 2), review(2, 6)]);
  assert.equal(result.state, 'uncertain');
  assert.equal(result.metrics.totalUsedPercent, null);
  assert.equal(result.metrics.totalDiscardedPercent, null);
  assert.equal(result.segments.at(-1).toAt, N + 2 * H);
  assert.equal(result.events.filter(e => e.kind === 'credit-use').length, 1);
});
test('simulation rejects malformed, simultaneous, duplicate, out-of-access and late reviews', () => {
  for (const rows of [[review(1, 4.1)], [review(3, 1)], [review(1, 1), review(1, 2)],
    [review(1, 1), review(2, 1)], [review(2, 2), review(1, 1)],
    [review(1, 1), review(2, 2), review(3, 3)], null, [{ number: 1, at: N + 0.5 }]]) {
    assert.equal(simulate(snapshot(), [slot(0, 8)], rows).state, 'incomplete');
  }
  assert.equal(simulate(snapshot(), [slot(0, 1), slot(3, 8)], [review(1, 2)]).state, 'incomplete');
});
test('invalid rates, windows, milliseconds and oversized slot schedules fail safely', () => {
  for (const rate of [0, -1, NaN, Infinity, '20']) assert.equal(simulate(snapshot(), [slot(0, 1)], [], { weeklyPerHour: rate }).state, 'incomplete');
  for (const rate of [-1, Infinity, '1']) assert.equal(simulate(snapshot(), [slot(0, 1)], [], { fiveHourPerHour: rate }).state, 'incomplete');
  for (const value of [snapshot({ week: 0 }), snapshot({ queriedAt: N + 1 }), snapshot({ usageWindows: [] }),
    snapshot({ weekly: NaN })]) assert.equal(simulate(value).state, 'incomplete');
  assert.equal(simulate(snapshot(), [slot(0, 8)], [], { now: N * 1000 }).state, 'incomplete');
  assert.equal(simulate(snapshot(), Array.from({ length: 33 }, () => slot(0, 1))).state, 'incomplete');
  assert.equal(simulate(snapshot(), [slot(0, 1), { startAt: NaN, endAt: N }]).state, 'incomplete');
});
test('malformed nonnumeric rates and speed factors never throw or coerce to a projection', () => {
  for (const value of [Symbol('rate'), 20n, {}, [], true, '20']) {
    for (const key of ['weeklyPerHour', 'fiveHourPerHour', 'speedFactor']) {
      let result;
      assert.doesNotThrow(() => { result = simulate(snapshot(), [slot(0, 1)], [], { [key]: value }); });
      assert.equal(result.state, 'incomplete');
    }
  }
});
test('eligible first two credits are ordered by expiry/number and all their expiry events survive horizon clipping', () => {
  const value = snapshot({ credits: [credit(3, 1, { status: 'used' }), credit(9, 9), credit(2, 4), credit(1, 4)] });
  const result = simulate(value, [slot(0, 2)], [review(1, 1), review(2, 2)]);
  assert.equal(result.horizonAt, N + 4 * H);
  assert.deepEqual(result.events.filter(e => e.kind === 'credit-expiry').map(e => e.creditNumber), [1, 2]);
  assert.equal(result.metrics.expiredCredits, 0);
});
test('access-only review saves expiry without consuming during the access interval', () => {
  const result = simulate(snapshot({ credits: [credit(1, 4)] }), [slot(0, 1)], [review(1, 4)],
    { accessSlots: [slot(0, 1), slot(3, 4)] });
  near(result.metrics.totalUsedPercent, 20);
  near(result.metrics.firstRemainingPercent, 30);
  assert.equal(result.metrics.expiredCredits, 0);
  assert.equal(result.horizonAt, N + 4 * H);
  assert.ok(result.segments.filter(s => s.fromAt >= N + H).every(s => s.fromPercent === s.toPercent));
});
test('simulation is immutable and bounded under extreme positive rates', () => {
  const value = snapshot(), slots = [slot(0, 8)], rows = [review(1, 2)];
  const copy = structuredClone([value, slots, rows]);
  for (const rate of [Number.MAX_VALUE, Number.MIN_VALUE, 1e-200, 1e200]) {
    const result = simulate(value, slots, rows, { weeklyPerHour: rate });
    assert.equal(result.state, 'ready'); finiteTree(result);
    assert.ok(result.segments.every(s => s.toAt >= s.fromAt && s.fromPercent >= 0 && s.fromPercent <= 100));
  }
  assert.deepEqual([value, slots, rows], copy);
});
const scored = (first, used, discarded, expired = 0, horizon = N + 8 * H) => ({
  state: 'ready', horizonAt: horizon, firstUseAt: first, metrics: { totalUsedPercent: used,
    totalDiscardedPercent: discarded, expiredCredits: expired } });
test('candidate comparison orders expiry, used, discarded then latest first review with float tolerance', () => {
  assert.equal(typeof engine.chooseRedemptionPlan, 'function');
  const a = scored(N, 200, 0, 1), b = scored(N + 1, 100, 10), c = scored(N + 2, 101, 20),
    d = scored(N + 3, 101, 19), e = scored(N + 4, 101 - 1e-7, 19 + 1e-7);
  assert.equal(engine.chooseRedemptionPlan([a, b, c, d, e]), e);
  assert.equal(engine.chooseRedemptionPlan([]), null);
  assert.equal(engine.chooseRedemptionPlan([{ ...a, state: 'incomplete' }, { ...b, metrics: { totalUsedPercent: NaN } }]), null);
});
test('candidate comparison declines unrelated horizons instead of rewarding a longer timeline', () => {
  assert.equal(typeof engine.chooseRedemptionPlan, 'function');
  assert.equal(engine.chooseRedemptionPlan([scored(N, 20, 0), scored(N, 100, 0, 0, N + 9 * H)]), null);
});
test('candidate comparison also declines the same end with different calculation reference times', () => {
  const a = simulate(snapshot(), [slot(0, 8)]);
  const b = engine.simulateUsage(snapshot({ queriedAt: N + H }), [slot(0, 8)], [], { now: N + H, weeklyPerHour: 20 });
  assert.equal(engine.chooseRedemptionPlan([a, b]), null);
});
test('candidate comparison declines malformed first review times', () => {
  for (const at of [undefined, NaN, Infinity, Symbol('time')]) {
    assert.equal(engine.chooseRedemptionPlan([scored(at, 50, 0)]), null);
  }
});
test('simulation and work plan reject ambiguous duplicate usage windows', () => {
  const value = snapshot(); value.usageWindows.push({ ...value.usageWindows[0] });
  assert.equal(simulate(value).state, 'incomplete');
  assert.equal(plan(value).state, 'incomplete');
});
test('sensitivity overflow remains unknown and explicitly warns rather than presenting an ordinary fast estimate', () => {
  const result = plan(snapshot(), { weeklyPerHour: Number.MAX_VALUE });
  assert.equal(result.schedule.scenarios.find(s => s.factor === 1.25).totalUsedPercent, null);
  assert.match(result.warnings.join(' '), /민감도.*범위|민감도.*계산.*보류/);
});
test('future expiry inside the safety margin allows immediate review while true expired credit is excluded', () => {
  const result = simulate(snapshot({ credits: [credit(1, -0.5), credit(2, -1)] }), [slot(0, 1)], [review(1, 0)]);
  assert.equal(result.state, 'ready');
  assert.equal(result.metrics.expiredCredits, 0);
  assert.equal(result.firstUseAt, N);
  assert.match(result.warnings.join(' '), /안전.*즉시|즉시.*안전/);
  assert.deepEqual(result.events.filter(e => e.kind === 'credit-expiry').map(e => e.creditNumber), [1]);
});

const plan = (value = snapshot(), options = {}) => {
  assert.equal(typeof engine.buildWorkSchedulePlan, 'function', 'plan export required');
  return engine.buildWorkSchedulePlan(value, { now: N, workSlots: [slot(0, 8)], weeklyPerHour: 20, ...options });
};
test('work plan returns every compatible field and every schedule field even when suspended', () => {
  const result = plan(null);
  assert.equal(result.state, 'not-ready');
  const top = ['state', 'code', 'title', 'reason', 'queriedAt', 'targetAt', 'requiredRatePerDay', 'ratePerDay',
    'exhaustsAt', 'remainingAtTarget', 'rateSource', 'coverage', 'firstCredit', 'nextCredit', 'firstUseAt',
    'nextGapSeconds', 'nextRequiredRatePerDay', 'nextRemainingPercent', 'events', 'segments', 'warnings', 'schedule'];
  assert.deepEqual(Object.keys(result).sort(), top.sort());
  const fields = ['recommendedStart', 'recommendedEnd', 'lastSafeAt', 'nextUseAt', 'totalUsedPercent',
    'totalDiscardedPercent', 'firstRemainingPercent', 'expiredCredits', 'blockedWorkHours', 'weeklyPerHour',
    'fiveHourPerHour', 'rateSource', 'workSlots', 'accessSlots', 'scenarios', 'candidates', 'assumptions',
    'reviewCreditNumber', 'reviewRemainingPercent'];
  assert.deepEqual(Object.keys(result.schedule).sort(), fields.sort());
  assert.deepEqual(result.segments, []);
  assert.equal(result.schedule.totalUsedPercent, null);
});
test('second-only rescue reduces expiry risk from two to one without falsely claiming a first review', () => {
  // Work 0–12h: old50 depletes2.5h; only access5–8h; first deadline4h is unreachable.
  // Second review7h leaves5h of work: old50+refill100=150 used,0 discarded,1 expired scenario credit.
  const value = snapshot(), options = { workSlots: [slot(0, 12)], accessSlots: [slot(5, 8)] };
  const baseline = simulate(value, options.workSlots, [], options);
  assert.equal(baseline.metrics.expiredCredits, 2);
  near(baseline.metrics.totalUsedPercent, 50);
  const result = plan(value, options);
  assert.equal(result.schedule.expiredCredits, 1);
  assert.equal(result.firstUseAt, null);
  assert.equal(result.schedule.firstRemainingPercent, null);
  assert.equal(result.schedule.nextUseAt, N + 7 * H);
  assert.equal(result.nextRemainingPercent, 0);
  assert.equal(result.schedule.reviewCreditNumber, 2);
  assert.equal(result.schedule.reviewRemainingPercent, 0);
  assert.equal(result.schedule.lastSafeAt, N + 8 * H);
  assert.equal(result.schedule.recommendedStart, N + 5 * H);
  assert.equal(result.schedule.recommendedEnd, N + 7 * H);
  assert.equal(result.targetAt, N + 8 * H);
  near(result.schedule.totalUsedPercent, 150);
  near(result.schedule.totalDiscardedPercent, 0);
  assert.deepEqual(result.events.filter(e => e.kind === 'credit-use').map(e => e.creditNumber), [2]);
  assert.match(result.reason, /첫.*만료|첫.*위험/);
  assert.match(result.reason, /2번.*검토/);
  assert.ok(result.schedule.candidates.some(c => c.firstUseAt === null && c.nextUseAt === N + 7 * H && c.expiredCredits === 1));
  assert.deepEqual(result.schedule.scenarios.map(s => s.expiredCredits), [1, 1, 1]);
});
test('simulation associates balances with eligible credit identity rather than chronological review ordinal', () => {
  const result = simulate(snapshot(), [slot(0, 12)], [review(2, 5)]);
  assert.equal(result.firstUseAt, null);
  assert.equal(result.nextUseAt, N + 5 * H);
  assert.equal(result.metrics.firstRemainingPercent, null);
  assert.equal(result.metrics.nextRemainingPercent, 0);
  assert.equal(result.metrics.expiredCredits, 1);
});
test('second-only candidates are evaluated even when first credit also has feasible access', () => {
  // Both deadlines now permit only one review. Both single-credit alternatives must be scored.
  const result = plan(snapshot({ credits: [credit(1, -0.5), credit(2, -0.4)] }));
  assert.equal(result.schedule.expiredCredits, 1);
  assert.ok(result.schedule.candidates.some(c => c.firstUseAt === N && c.nextUseAt === null));
  assert.ok(result.schedule.candidates.some(c => c.firstUseAt === null && c.nextUseAt === N));
  assert.equal(result.schedule.reviewCreditNumber, 1);
  assert.equal(result.schedule.reviewRemainingPercent, 50);
});
test('second-only recommended window never bridges separated access intervals', () => {
  const result = plan(snapshot({ five: 0 }), { accessSlots: [slot(5, 5.25), slot(7.5, 8)] });
  assert.equal(result.firstUseAt, null);
  assert.equal(result.schedule.nextUseAt, N + 8 * H);
  assert.equal(result.schedule.recommendedStart, N + 7.5 * H);
  assert.equal(result.schedule.recommendedEnd, N + 8 * H);
  assert.equal(result.schedule.reviewCreditNumber, 2);
  assert.equal(result.schedule.reviewRemainingPercent, 50);
});
test('unknown second-only review remains provisional without numeric after-effect claims', () => {
  const result = plan(snapshot({ credits: [credit(1, 4), credit(2, 8, { resetType: 'unknown' })] }),
    { accessSlots: [slot(5, 8)] });
  assert.equal(result.firstUseAt, null);
  assert.equal(result.schedule.nextUseAt, N + 8 * H);
  assert.equal(result.schedule.reviewCreditNumber, 2);
  assert.equal(result.schedule.expiredCredits, 1);
  assert.equal(result.schedule.totalUsedPercent, null);
  assert.deepEqual(result.schedule.scenarios, []);
  assert.ok(result.segments.every(s => s.toAt <= result.schedule.nextUseAt));
});
test('work plan chooses both credits using active work depletion and identical horizons', () => {
  const result = plan();
  assert.equal(result.state, 'ready');
  assert.equal(result.firstUseAt, N + 2.5 * H);
  assert.equal(result.schedule.nextUseAt, N + 7.5 * H);
  near(result.schedule.totalUsedPercent, 160);
  near(result.schedule.totalDiscardedPercent, 0);
  near(result.schedule.firstRemainingPercent, 0);
  assert.equal(result.schedule.expiredCredits, 0);
  assert.equal(result.nextGapSeconds, 5.5 * H);
  assert.equal(result.schedule.lastSafeAt, N + 4 * H);
  for (const key of ['ratePerDay', 'requiredRatePerDay', 'nextRequiredRatePerDay', 'exhaustsAt']) assert.equal(result[key], null);
  assert.deepEqual(result.schedule.scenarios.map(s => [s.label, s.factor]), [['느림', 0.75], ['기준', 1], ['빠름', 1.25]]);
  assert.deepEqual(result.schedule.scenarios, [
    { label: '느림', factor: 0.75, totalUsedPercent: 120, totalDiscardedPercent: 37.5, expiredCredits: 0 },
    { label: '기준', factor: 1, totalUsedPercent: 160, totalDiscardedPercent: 0, expiredCredits: 0 },
    { label: '빠름', factor: 1.25, totalUsedPercent: 162.5, totalDiscardedPercent: 0, expiredCredits: 0 },
  ]);
  assert.ok(result.schedule.candidates.length <= 8);
  assert.match(result.reason, /후보|평가/);
  assert.match(result.schedule.assumptions.join(' '), /민감도|확률.*아/);
});
test('work plan optimal window derives from equivalent primary outcomes rather than arbitrary padding', () => {
  // Unknown five-hour consumption cannot restore an actual zero at a credit: all reviews tie.
  const result = plan(snapshot({ weekly: 100, five: 0, credits: [credit(1, 4)] }));
  assert.equal(result.schedule.recommendedStart, N);
  assert.equal(result.schedule.recommendedEnd, N + 4 * H);
  near(result.schedule.totalUsedPercent, 0);
  near(result.schedule.totalDiscardedPercent, 100);
});
test('work plan uses actual access end for last safe time and access-only rescue', () => {
  const result = plan(snapshot({ credits: [credit(1, 4)] }), { workSlots: [slot(0, 1)], accessSlots: [slot(3, 3.5)] });
  assert.equal(result.schedule.lastSafeAt, N + 3.5 * H);
  assert.equal(result.firstUseAt, N + 3.5 * H);
  assert.equal(result.schedule.expiredCredits, 0);
  near(result.schedule.totalUsedPercent, 20);
  near(result.schedule.totalDiscardedPercent, 30);
});
test('work plan with no feasible first access warns of risk and never claims a saved first credit', () => {
  const result = plan(snapshot({ credits: [credit(1, 4)] }), { workSlots: [slot(5, 8)] });
  assert.equal(result.state, 'ready');
  assert.equal(result.firstUseAt, null);
  assert.equal(result.schedule.lastSafeAt, null);
  assert.equal(result.targetAt, N + 4 * H);
  assert.equal(result.schedule.expiredCredits, 1);
  assert.match(result.reason + result.warnings.join(' '), /접속.*없|접속.*불가/);
});
test('work plan keeps first-only alternatives when next credit has no feasible access', () => {
  // Both still-future expiries have policy deadlines clamped to now: only one review fits.
  const single = plan(snapshot({ credits: [credit(1, -0.5), credit(2, -0.4)] }));
  assert.equal(single.firstUseAt, N);
  assert.equal(single.schedule.nextUseAt, null);
  assert.equal(single.schedule.expiredCredits, 1);
});
test('work plan handles same expiries with strictly separated proposed reviews', () => {
  const result = plan(snapshot({ credits: [credit(2, 4), credit(1, 4)] }));
  assert.equal(result.firstCredit.number, 1);
  assert.equal(result.nextCredit.number, 2);
  assert.ok(result.schedule.nextUseAt > result.firstUseAt);
  assert.equal(result.schedule.expiredCredits, 0);
});
test('work plan preserves read/restriction guards and true zero work safety', () => {
  for (const [value, options, state] of [
    [snapshot(), { stale: true }, 'refresh-needed'], [snapshot(), { refreshing: true }, 'refreshing'],
    [snapshot({ ordinaryUsageAllowed: false }), {}, 'server-restricted'],
    [snapshot({ week: 0 }), {}, 'refresh-needed'], [snapshot({ queriedAt: N + 1 }), {}, 'refresh-needed'],
    [snapshot({ usageWindows: [] }), {}, 'incomplete'],
  ]) {
    const result = plan(value, options);
    assert.equal(result.state, state); assert.equal(result.firstUseAt, null);
    assert.equal(result.schedule.totalUsedPercent, null); assert.deepEqual(result.segments, []);
  }
  const zero = plan(snapshot({ five: 0, fiveReset: 2 }), { fiveHourPerHour: null });
  assert.equal(zero.state, 'ready');
  assert.match(zero.reason + zero.warnings.join(' '), /0%|소진/);
  assert.ok(zero.schedule.blockedWorkHours > 0);
});
test('an unknown next effect keeps the entire work plan provisional and stops its graph at first review', () => {
  const result = plan(snapshot({ credits: [credit(1, 4), credit(2, 8, { resetType: 'unknown' })] }));
  assert.equal(result.schedule.totalUsedPercent, null);
  assert.equal(result.schedule.nextUseAt, null);
  assert.ok(result.segments.every(s => s.toAt <= result.firstUseAt));
});
test('simulation exposes each discarded weekly allowance separately for credit and natural resets', () => {
  const result = simulate(snapshot({ weekly: 80, week: 2 }), [slot(0, 8)], [review(1, 4)]);
  assert.deepEqual(result.discards, [
    { kind: 'weekly-reset', at: N + 2 * H, creditNumber: null, remainingPercent: 40 },
    { kind: 'credit-use', at: N + 4 * H, creditNumber: 1, remainingPercent: 60 },
  ]);
});
test('work plan declines missing work, rate and invalid input without estimating fictional zero consumption', () => {
  for (const options of [{ workSlots: [] }, { weeklyPerHour: null }, { weeklyPerHour: 0 },
    { weeklyPerHour: Infinity }, { fiveHourPerHour: -1 }, { workSlots: 'bad' },
    { accessSlots: Array.from({ length: 33 }, () => slot(0, 1)) }]) {
    const result = plan(snapshot(), options);
    assert.equal(result.state, 'incomplete'); assert.equal(result.schedule.totalUsedPercent, null);
    assert.equal(result.firstUseAt, null);
  }
});
test('work plan with unknown credit effect offers only provisional first review without numeric optimization', () => {
  const result = plan(snapshot({ credits: [credit(1, 4, { resetType: 'unknown' }), credit(2, 8)] }));
  assert.equal(result.state, 'ready');
  assert.equal(result.firstUseAt, N + 4 * H);
  assert.equal(result.schedule.nextUseAt, null);
  assert.equal(result.schedule.totalUsedPercent, null);
  assert.deepEqual(result.schedule.scenarios, []);
  assert.deepEqual(result.schedule.candidates, []);
  assert.match(result.warnings.join(' '), /효과.*미확인|효과.*확인할 수/);
  assert.ok(result.segments.every(s => s.toAt <= result.firstUseAt));
});
test('work plan without dated eligible credits uses current natural-reset plan and warns on partial details', () => {
  const result = plan(snapshot({ credits: [], week: 4 }));
  assert.equal(result.state, 'ready'); assert.equal(result.firstUseAt, null);
  assert.equal(result.firstCredit, null);
  near(result.schedule.totalUsedPercent, 130);
  assert.equal(result.schedule.expiredCredits, 0);
  const partial = plan(snapshot({ detailState: 'partial', availableCount: 5 }));
  assert.match(partial.reason + partial.warnings.join(' '), /조회된|일부|부분/);
  const count = plan(snapshot({ detailState: 'count-only', availableCount: 9 }));
  assert.equal(count.firstCredit, null);
  assert.match(count.warnings.join(' '), /상세|만료/);
});
test('recommended window stays inside the chosen access interval across separated 13:00 and 19:30 slots', () => {
  const value = snapshot({ weekly: 100, five: 0, credits: [credit(1, 20)] });
  const result = plan(value, { workSlots: [slot(13, 13.25), slot(19.5, 20)],
    accessSlots: [slot(13, 13.25), slot(19.5, 20)] });
  assert.equal(result.firstUseAt, N + 20 * H);
  assert.equal(result.schedule.recommendedStart, N + 19.5 * H);
  assert.equal(result.schedule.recommendedEnd, N + 20 * H);
});
test('projections process all entered work after the second deadline on a shared horizon', () => {
  const value = snapshot({ weekly: 50, credits: [credit(1, 4), credit(2, 8)] });
  const slots = [slot(0, 12)], result = simulate(value, slots, [review(1, 2.5), review(2, 7.5)]);
  assert.equal(result.horizonAt, N + 12 * H);
  assert.deepEqual(result.workSlots, slots);
  near(result.metrics.totalUsedPercent, 240);
  near(result.metrics.totalDiscardedPercent, 0);
  const built = plan(value, { workSlots: slots });
  near(built.schedule.totalUsedPercent, 240);
  assert.deepEqual(built.schedule.workSlots, slots);
  assert.equal(built.segments.at(-1).toAt, N + 12 * H);
  assert.match(built.schedule.assumptions.join(' '), /계산 범위|계산 종료/);
});
test('post-second planned work changes the selected schedule compared with early second disposal', () => {
  const value = snapshot(), work = [slot(0, 12)];
  const best = simulate(value, work, [review(1, 2.5), review(2, 7.5)]);
  const early = simulate(value, work, [review(1, 2.5), review(2, 4)]);
  near(best.metrics.totalUsedPercent, 240);
  near(early.metrics.totalUsedPercent, 180);
  near(early.metrics.totalDiscardedPercent, 70);
  assert.equal(engine.chooseRedemptionPlan([early, best]), best);
});
test('work plan urgent safety deadline offers now while distinguishing true expiry', () => {
  const result = plan(snapshot({ credits: [credit(1, -0.5)] }));
  assert.equal(result.firstUseAt, N);
  assert.equal(result.firstCredit.deadlineAt, N);
  assert.equal(result.schedule.lastSafeAt, N);
  assert.equal(result.schedule.expiredCredits, 0);
  assert.match(result.warnings.join(' '), /즉시/);
});
test('work plan stays deterministic, immutable and finite for 32 intervals and extreme rates', () => {
  const value = snapshot({ credits: [credit(1, 1000), credit(2, 2000)], week: 3000, fiveReset: 3000 });
  const options = { workSlots: Array.from({ length: 32 }, (_, i) => slot(i * 60, i * 60 + 50)) };
  const copy = structuredClone([value, options]);
  const result = plan(value, options);
  assert.equal(result.state, 'ready'); finiteTree(result);
  assert.deepEqual(result, plan(value, options)); assert.deepEqual([value, options], copy);
  for (const rate of [1e-200, 1e200, Number.MAX_VALUE, Number.MIN_VALUE]) finiteTree(plan(snapshot(), { weeklyPerHour: rate }));
});
