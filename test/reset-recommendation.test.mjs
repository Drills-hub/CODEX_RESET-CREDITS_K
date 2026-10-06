import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendReset } from '../public/reset-recommendation.mjs';
const N = 1791072000, H = 3600, D = 86400;
const credit = (expiresAt, patch = {}) => ({ number: 1, title: '리셋권', status: 'available', expiryState: 'known', expiresAt, ...patch });
const snapshot = (expiresAt = N + D, patch = {}) => ({ queriedAt: N, availableCount: 1, detailState: 'complete', credits: [credit(expiresAt)], ordinaryUsageAllowed: true,
  usageWindows: [{ kind: 'five-hour', resetsAt: N + 5 * H }, { kind: 'weekly', resetsAt: N + 7 * D }], ...patch });
const rec = (s, options = {}) => recommendReset(s, { now: N, ...options });
test('expiry thresholds include exactly seven days and twenty-four hours', () => {
  for (const [seconds, code] of [[7 * D, 'free-use'], [7 * D - 1, 'prepare'], [D + 1, 'prepare'], [D, 'deadline']]) {
    assert.equal(rec(snapshot(N + seconds)).code, code);
  }
  assert.equal(rec(snapshot(N + 7 * D)).title, '자유롭게 사용');
  assert.equal(rec(snapshot()).deadlineAt, N + 23 * H);
  assert.equal(rec(snapshot()).title, '08시 사용을 추천합니다!');
});
test('selects earliest eligible credit and reports partial coverage', () => {
  const value = rec(snapshot(N + D, { detailState: 'partial', credits: [credit(N + D), credit(N + 3 * H, { number: 3 }), credit(N + 3 * H, { number: 2 }), credit(N + H, { status: 'redeemed' })] }));
  assert.equal(value.credit.number, 2);
  assert.match(value.reason, /조회된 항목 기준/);
});
test('distinguishes zero, count only, unknown expiry, no expiry and missing information', () => {
  for (const [patch, code] of [[{ availableCount: 0, credits: [] }, 'no-credits'], [{ detailState: 'count-only', credits: [] }, 'count-only'], [{ credits: [credit(null, { expiryState: 'none' })] }, 'no-expiry'], [{ credits: [credit(null, { expiryState: 'unknown' })] }, 'unknown-expiry'], [{ detailState: 'unavailable' }, 'unavailable']]) {
    assert.equal(rec(snapshot(N + D, patch)).code, code);
  }
});
test('deadline within an hour or rounded hour in the past recommends now', () => {
  assert.equal(rec(snapshot(N + H / 2)).code, 'use-now');
  assert.equal(rec(snapshot(N + 2 * H), { now: N + 1800 }).title, '10시 사용을 추천합니다!');
  const s = snapshot(N + H + 1800, { queriedAt: N + 600 });
  assert.equal(rec(s, { now: N + 600 }).title, '지금 사용을 추천합니다!');
});
test('elapsed recommendation, credit expiry and natural reset require successful requery', () => {
  const s = snapshot(N + 3 * H);
  assert.equal(rec(s, { now: N + 2 * H }).code, 'refresh-needed');
  assert.equal(rec({ ...s, queriedAt: N + 2 * H }, { now: N + 2 * H }).code, 'use-now');
  assert.equal(rec(snapshot(N + D), { now: N + 5 * H }).code, 'refresh-needed');
  assert.equal(rec(snapshot(N + D, { credits: [credit(N + H), credit(N + D)] }), { now: N + H }).code, 'refresh-needed');
});
test('refresh and restriction states never offer executable guidance', () => {
  assert.equal(rec(null).code, 'not-ready');
  assert.equal(rec(snapshot(), { refreshing: true }).code, 'refreshing');
  assert.equal(rec(snapshot(), { stale: true }).code, 'refresh-needed');
  assert.equal(rec(snapshot(N + D, { ordinaryUsageAllowed: false })).code, 'server-restricted');
  assert.equal(rec(snapshot(), { now: N - 1 }).code, 'refresh-needed');
});
test('already expired rows are excluded after a successful read and do not invent a date', () => {
  assert.equal(rec(snapshot(N - H, { credits: [credit(N - H), credit(N + D)] })).credit.expiresAt, N + D);
  assert.equal(rec(snapshot(N - H)).code, 'expired');
});
