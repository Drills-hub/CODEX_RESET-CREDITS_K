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
  assert.equal(remainingTime(100, 100000), '만료 시각 경과 — 새로고침 필요');
});
test('summary unavailable differs from zero and count-only data', () => {
  assert.equal(normalizeCredits({}, 0).detailState, 'unavailable');
  assert.equal(normalizeCredits({ rateLimitResetCredits: null }, 0).availableCount, null);
  const zero = normalizeCredits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }, 0);
  assert.match(emptyMessage(zero), /없습니다/);
  const only = normalizeCredits({ rateLimitResetCredits: { availableCount: 3, credits: null } }, 0);
  assert.equal(only.detailState, 'count-only');
  assert.equal(only.availableCount, 3);
  assert.match(emptyMessage(only), /상세 정보 미제공/);
});
test('sorts known expirations first, preserves null versus missing, strips sensitive fields', () => {
  const snapshot = normalizeCredits({
    accountId: 'SECRET_ACCOUNT', accessToken: 'SECRET_TOKEN',
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
  const s = normalizeCredits({ rateLimitResetCredits: { availableCount: 2, credits: [
    { grantedAt: '100', expiresAt: '500', status: 'surprise' },
    { grantedAt: 0, expiresAt: 1e20, status: 'redeemed' },
  ] } }, 0);
  assert.equal(s.credits[0].grantedAt, null);
  assert.equal(s.credits[0].expiryState, 'unknown');
  assert.equal(s.credits[0].status, 'unknown');
  assert.equal(s.credits[1].expiryState, 'unknown');
  assert.throws(() => normalizeCredits({ rateLimitResetCredits: { availableCount: -1 } }, 0));
});
