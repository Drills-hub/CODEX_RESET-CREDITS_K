import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarEvents, kstDateKey, monthDates, shiftMonth } from '../public/expiry-calendar.mjs';
const N = 1791072000;
test('KST groups both sides of midnight and leap-year months', () => {
  assert.equal(kstDateKey(Date.parse('2026-12-31T14:59:59Z') / 1000), '2026-12-31');
  assert.equal(kstDateKey(Date.parse('2026-12-31T15:00:00Z') / 1000), '2027-01-01');
  assert.equal(monthDates('2024-02').length, 29);
  assert.equal(monthDates('2026-02').length, 28);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
});
test('same-time events sort credits then five-hour then weekly without recurring dates', () => {
  const s = { detailState: 'partial', credits: [
    { number: 2, title: '둘', status: 'available', expiryState: 'known', expiresAt: N },
    { number: 1, title: '하나', status: 'available', expiryState: 'known', expiresAt: N },
    { number: 3, status: 'redeemed', expiryState: 'known', expiresAt: N },
    { number: 4, status: 'available', expiryState: 'none', expiresAt: null },
  ], usageWindows: [{ kind: 'weekly', resetsAt: N }, { kind: 'five-hour', resetsAt: N }] };
  const value = calendarEvents(s);
  assert.deepEqual(value.events.map(e => e.kind), ['credit-expiry', 'credit-expiry', 'five-hour-reset', 'weekly-reset']);
  assert.deepEqual(value.events.slice(0, 2).map(e => e.number), [1, 2]);
  assert.ok(value.events.every(e => e.date === '2026-10-04'));
  assert.match(value.notes.join(' '), /조회된 항목 기준.*만료 없음/);
});
test('unknown, unavailable and count-only details are not converted into dates', () => {
  assert.equal(calendarEvents(null).state, 'not-ready');
  for (const detailState of ['unavailable', 'count-only']) {
    const value = calendarEvents({ detailState, credits: [], usageWindows: [] });
    assert.equal(value.events.length, 0);
    assert.ok(value.notes.length > 0);
  }
  const value = calendarEvents({ detailState: 'complete', credits: [{ status: 'available', expiryState: 'unknown', expiresAt: null }], usageWindows: [] });
  assert.equal(value.events.length, 0);
  assert.match(value.notes.join(' '), /만료 시각 확인 불가/);
});
test('KST conversion rejects dates that overflow after timezone adjustment', () => {
  assert.equal(kstDateKey(8640000000000), null);
  const data = calendarEvents({ detailState: 'complete', credits: [{ number: 1, status: 'available', expiryState: 'known', expiresAt: 8640000000000 }], usageWindows: [{ kind: 'weekly', resetsAt: 8640000000000 }] });
  assert.equal(data.events.length, 0);
  assert.match(data.notes.join(' '), /만료 시각 확인 불가.*주간 한도 리셋 시각 확인 불가/);
});
