import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSummaryTime, formatSummaryRemaining, buildRecommendationDisplay } from '../public/display.mjs';

const nowMs = Date.parse('2026-10-04T00:00:00Z');
const N = nowMs / 1000;
test('summary time distinguishes KST today, the next day and another year', () => {
  for (const [at, want] of [
    ['2026-10-04T11:30:00Z', '오늘 20:30'],
    ['2026-10-04T14:59:59Z', '오늘 23:59'],
    ['2026-10-04T15:00:00Z', '10/05 00:00'],
    ['2026-12-31T15:00:00Z', '2027-01-01 00:00'],
  ]) assert.equal(formatSummaryTime(Date.parse(at) / 1000, { nowMs }), want);
  assert.equal(formatSummaryTime(N, { nowMs: nowMs + 86400000 }), '10/04 09:00');
});
test('display time safely rejects malformed timestamps and clocks', () => {
  for (const at of [null, undefined, '123', -1, NaN, Infinity, N + 0.5, 8640000000000]) {
    assert.equal(formatSummaryTime(at, { nowMs }), '확인 불가');
    assert.equal(formatSummaryRemaining(at, { nowMs }), '확인 불가');
  }
  for (const now of [null, '0', NaN, Infinity, -1, 8640000000000000]) {
    assert.equal(formatSummaryTime(N, { nowMs: now }), '확인 불가');
    assert.equal(formatSummaryRemaining(N, { nowMs: now }), '확인 불가');
  }
  assert.equal(formatSummaryTime(0, { nowMs: 0 }), '오늘 09:00');
});
test('remaining summaries round minutes while distinguishing subminute and elapsed deadlines', () => {
  for (const [seconds, want] of [[-1, '시각 경과 · 재조회 필요'], [0, '시각 경과 · 재조회 필요'],
    [1, '1분 미만 남음'], [59, '1분 미만 남음'], [60, '1분 남음'], [61, '2분 남음'],
    [3600, '1시간 0분 남음'], [3661, '1시간 2분 남음'], [86400, '1일 0시간 0분 남음']]) {
    assert.equal(formatSummaryRemaining(N + seconds, { nowMs }), want);
  }
});
test('recommendation display keeps exact deadline and detail reason without changing the input', () => {
  const result = { code: 'use-now', title: '지금 사용을 추천합니다!', reason: '권장 마감에 관한 전체 근거', targetAt: N, deadlineAt: N - 1800 };
  const snapshot = { detailState: 'partial', credits: [{ status: 'available', expiryState: 'unknown' }] };
  const before = structuredClone([result, snapshot]);
  assert.deepEqual(buildRecommendationDisplay(result, snapshot), {
    title: '지금 사용을 추천합니다!', summaryReason: '만료 전에 최신 상태를 확인하고 사용을 검토하세요.', detailReason: '권장 마감에 관한 전체 근거',
    deadlineAt: N - 1800, tone: 'deadline', scopeNote: '조회된 항목 기준 · 일부 만료 시각 확인 불가',
  });
  assert.deepEqual([result, snapshot], before);
});
test('recommendation tone and summary retain distinct operational states', () => {
  const rows = [
    ['free-use', 'neutral', '만료까지 7일 이상 남았습니다.'],
    ['prepare', 'neutral', '현재 한도를 사용한 뒤 리셋권 사용을 준비하세요.'],
    ['deadline', 'deadline', '현재 한도를 가능한 만큼 사용한 뒤 권장 마감에 확인하세요.'],
    ['refreshing', 'pending', '조회가 완료되면 추천을 다시 안내합니다.'],
    ['refresh-needed', 'error', '최신 상태를 재조회해 주세요.'],
    ['server-restricted', 'error', '서버가 일반 사용을 제한했습니다. 최신 상태를 확인하세요.'],
    ['no-credits', 'neutral', '원래 근거'], ['unknown-expiry', 'neutral', '원래 근거'],
  ];
  for (const [code, tone, summaryReason] of rows) {
    const value = buildRecommendationDisplay({ code, title: '제목', reason: '원래 근거', deadlineAt: null }, null);
    assert.deepEqual(value, { title: '제목', detailReason: '원래 근거', deadlineAt: null, tone, summaryReason, scopeNote: '' });
  }
});
test('coverage note includes unavailable expiry only for available credits', () => {
  const r = { code: 'prepare', title: '제목', reason: '근거', deadlineAt: null };
  const note = credits => buildRecommendationDisplay(r, { detailState: 'complete', credits }).scopeNote;
  assert.equal(note([{ status: 'available', expiryState: 'known', expiresAt: 8640000000000 }]), '일부 만료 시각 확인 불가');
  assert.equal(note([{ status: 'redeemed', expiryState: 'unknown' }, { status: 'available', expiryState: 'none' }]), '');
  assert.equal(buildRecommendationDisplay(r, { detailState: 'partial', credits: [] }).scopeNote, '조회된 항목 기준');
});
