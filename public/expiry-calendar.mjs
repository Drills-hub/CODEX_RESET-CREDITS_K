const timeValid = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;
export function kstDateKey(seconds) {
  if (!timeValid(seconds)) return null;
  const date = new Date(seconds * 1000 + 9 * 3600000);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString().slice(0, 10);
}
export function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}
export function monthDates(month) {
  const [year, number] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}
export function calendarEvents(snapshot) {
  if (!snapshot) return { state: 'not-ready', events: [], notes: ['조회 후 만료·리셋 일정을 표시합니다.'] };
  const events = [], notes = [];
  const add = (kind, title, at, number = null) => {
    const date = kstDateKey(at);
    if (date) events.push({ kind, title, at, number, date });
  };
  if (snapshot.detailState === 'partial') notes.push('리셋권 일정은 조회된 항목 기준입니다.');
  if (snapshot.detailState === 'count-only') notes.push('리셋권 개수만 제공되어 만료 일정을 표시할 수 없습니다.');
  if (snapshot.detailState === 'unavailable') notes.push('리셋권 정보를 확인할 수 없습니다.');
  const available = ['complete', 'partial'].includes(snapshot.detailState) ? (snapshot.credits ?? []).filter(row => row.status === 'available') : [];
  for (const row of available) if (row.expiryState === 'known') add('credit-expiry', `리셋권 ${row.number} 만료 · ${row.title || '리셋권'}`, row.expiresAt, row.number);
  if (available.some(row => row.expiryState === 'none')) notes.push('만료 없음: 해당 리셋권은 날짜에 배정하지 않습니다.');
  if (available.some(row => row.expiryState === 'unknown' || row.expiryState === 'known' && !kstDateKey(row.expiresAt))) notes.push('만료 시각 확인 불가: 해당 리셋권은 날짜에 배정하지 않습니다.');
  for (const [kind, title] of [['five-hour', '5시간 한도 리셋'], ['weekly', '주간 한도 리셋']]) {
    const rows = (snapshot.usageWindows ?? []).filter(row => row.kind === kind);
    if (rows.length === 1 && kstDateKey(rows[0].resetsAt)) add(`${kind}-reset`, title, rows[0].resetsAt);
    else notes.push(`${title} 시각 확인 불가`);
  }
  const order = { 'credit-expiry': 0, 'five-hour-reset': 1, 'weekly-reset': 2 };
  events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind] || a.number - b.number);
  return { state: 'ready', events, notes };
}

export function upcomingEvents(snapshot, nowSeconds = Date.now() / 1000, events = calendarEvents(snapshot).events) {
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0 || !Array.isArray(events)) return [];
  return events.filter(event => event.at > nowSeconds).slice(0, 3);
}
