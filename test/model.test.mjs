import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredits } from '../lib/credits.mjs';
import { formatKst, remainingTime, emptyMessage } from '../public/time.mjs';

test('Unix seconds convert across the KST date boundary', () => {
  assert.equal(formatKst(0), '1970-01-01 09:00:00 KST (UTC+09:00)');
  assert.equal(formatKst(1767196800), '2026-01-01 01:00:00 KST (UTC+09:00)');
  assert.equal(formatKst(null), '확인 불가');
});
test('countdown uses the local clock and never becomes negative', () => {
  assert.equal(remainingTime(183845, 0), '2일 03시간 04분 05초');
  assert.equal(remainingTime(100, 100000), '만료 시각 경과: 새로고침 필요');
});
test('summary unavailable differs from zero and count-only data', () => {
  assert.equal(normalizeCredits({ rateLimits: {} }, 0).detailState, 'unavailable');
  assert.equal(normalizeCredits({ rateLimits: {}, rateLimitResetCredits: null }, 0).availableCount, null);
  const zero = normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 0, credits: [] } }, 0);
  assert.match(emptyMessage(zero), /없습니다/);
  const only = normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 3, credits: null } }, 0);
  assert.equal(only.detailState, 'count-only');
  assert.equal(only.availableCount, 3);
  assert.match(emptyMessage(only), /상세 정보가 제공되지 않았/);
});
test('required rate-limit envelope is validated while optional reset details remain unavailable', () => {
  for (const result of [{}, { rateLimits: null }, { rateLimits: [] }, { rateLimits: 'bad' }]) {
    assert.throws(() => normalizeCredits(result), error => error.code === 'INCOMPATIBLE');
  }
  assert.equal(normalizeCredits({ rateLimits: {} }).detailState, 'unavailable');
  assert.equal(normalizeCredits({ rateLimits: {}, rateLimitResetCredits: null }).detailState, 'unavailable');
});
test('sorts known expirations first, preserves null versus missing, strips sensitive fields', () => {
  const snapshot = normalizeCredits({
    accountId: 'SECRET_ACCOUNT', accessToken: 'SECRET_TOKEN',
    rateLimits: {},
    rateLimitResetCredits: { availableCount: 5, credits: [
      { id: 'SECRET_CREDIT', title: '<img src=x onerror=alert(1)>', status: 'available', grantedAt: 10, expiresAt: 500 },
      { id: 'x', status: 'available', grantedAt: 10, expiresAt: null },
      { id: 'y', status: 'available', grantedAt: 10 },
      { id: 'z', status: 'available', grantedAt: 10, expiresAt: 100 },
    ] } }, 1000);
  assert.equal(snapshot.detailState, 'partial');
  assert.equal(snapshot.availableCount, 5);
  assert.deepEqual(snapshot.credits.map(x => x.expiryState), ['known', 'known', 'none', 'unknown']);
  assert.deepEqual(snapshot.credits.map(x => x.number), [1, 2, 3, 4]);
  assert.equal(snapshot.credits[0].expiresAt, 100);
  assert.equal(snapshot.credits[1].title, '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});
test('invalid timestamps and unknown statuses fail safely', () => {
  const s = normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: 2, credits: [
    { grantedAt: '100', expiresAt: '500', status: 'surprise' },
    { grantedAt: 0, expiresAt: 1e20, status: 'redeemed' },
  ] } }, 0);
  assert.equal(s.credits[0].grantedAt, null);
  assert.equal(s.credits[0].expiryState, 'unknown');
  assert.equal(s.credits[0].status, 'unknown');
  assert.equal(s.credits[1].expiryState, 'unknown');
  assert.throws(() => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: -1 } }, 0), error => error.code === 'INCOMPATIBLE');
});

test('stable reminder keys distinguish identical display rows without exposing raw IDs', () => {
  const normalize = rows => normalizeCredits({ rateLimits: {}, rateLimitResetCredits: { availableCount: rows.length, credits: rows } }).credits;
  const row = { title: 'same', status: 'available', grantedAt: 1, expiresAt: 100 };
  const rows = normalize([{ ...row, id: 'PRIVATE_FIRST' }, { ...row, id: 'PRIVATE_SECOND' }]);
  assert.match(rows[0].reminderKey, /^[a-f0-9]{64}$/);
  assert.notEqual(rows[0].reminderKey, rows[1].reminderKey);
  assert.equal(normalize([{ ...row, id: 'PRIVATE_SECOND' }])[0].reminderKey, rows[1].reminderKey);
  assert.equal(normalize([row])[0].reminderKey, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/);
});

test('usage windows are identified by duration, not primary and secondary position', () => {
  const snapshot = normalizeCredits({ rateLimits: {
    primary: { windowDurationMins: 10080, usedPercent: 80, resetsAt: 90000 },
    secondary: { windowDurationMins: 300, usedPercent: 35, resetsAt: 18000 },
    accountId: 'SECRET_USAGE',
  }, ordinaryUsageAllowed: false }, 1000);
  assert.deepEqual(snapshot.usageWindows, [
    { kind: 'five-hour', windowDurationMins: 300, usedPercent: 35, remainingPercent: 65, resetsAt: 18000, state: 'complete' },
    { kind: 'weekly', windowDurationMins: 10080, usedPercent: 80, remainingPercent: 20, resetsAt: 90000, state: 'complete' },
  ]);
  assert.equal(snapshot.ordinaryUsageAllowed, false);
  assert.equal(snapshot.detailState, 'unavailable');
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_USAGE/);
});

test('usage values distinguish zero from missing and preserve independently valid fields', () => {
  const snapshot = normalizeCredits({ rateLimits: {
    primary: { windowDurationMins: 300, usedPercent: 100, resetsAt: null },
    secondary: { windowDurationMins: 10080, usedPercent: null, resetsAt: 90000 },
  } });
  assert.equal(snapshot.usageWindows[0].remainingPercent, 0);
  assert.equal(snapshot.usageWindows[0].state, 'partial');
  assert.equal(snapshot.usageWindows[0].resetsAt, null);
  assert.equal(snapshot.usageWindows[1].remainingPercent, null);
  assert.equal(snapshot.usageWindows[1].resetsAt, 90000);
  assert.equal(snapshot.ordinaryUsageAllowed, null);
});

test('malformed usage fields do not break credit details or invent a usage window', () => {
  for (const usedPercent of [-1, 101, 0.5, '20', Infinity, NaN]) {
    const snapshot = normalizeCredits({ rateLimits: {
      primary: { windowDurationMins: 300, usedPercent, resetsAt: '18000' },
      secondary: { windowDurationMins: 60, usedPercent: 10, resetsAt: 20000 },
    }, ordinaryUsageAllowed: 'true', rateLimitResetCredits: { availableCount: 1, credits: [] } });
    assert.equal(snapshot.availableCount, 1);
    assert.equal(snapshot.usageWindows[0].state, 'invalid');
    assert.equal(snapshot.usageWindows[0].remainingPercent, null);
    assert.equal(snapshot.usageWindows[0].resetsAt, null);
    assert.equal(snapshot.usageWindows[1].state, 'unavailable');
    assert.equal(snapshot.ordinaryUsageAllowed, null);
  }
  for (const rateLimits of [{}, { primary: [] }, { primary: 'bad' }, { primary: { usedPercent: 0 } }]) {
    assert.ok(normalizeCredits({ rateLimits }).usageWindows.every(row => row.state === 'unavailable'));
  }
});

test('duplicate durations are ambiguous and never silently overwrite one another', () => {
  const snapshot = normalizeCredits({ rateLimits: {
    primary: { windowDurationMins: 300, usedPercent: 0, resetsAt: 18000 },
    secondary: { windowDurationMins: 300, usedPercent: 100, resetsAt: 18001 },
  } });
  assert.equal(snapshot.usageWindows[0].state, 'invalid');
  assert.equal(snapshot.usageWindows[0].remainingPercent, null);
  assert.equal(snapshot.usageWindows[0].resetsAt, null);
});
