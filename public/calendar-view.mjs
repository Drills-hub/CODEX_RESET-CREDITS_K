import { calendarEvents, kstDateKey, monthDates, shiftMonth } from './expiry-calendar.mjs';
import { formatKst, remainingTime } from './time.mjs';
import { formatSummaryTime, formatSummaryRemaining } from './display.mjs';

export function createCalendarView(root) {
  const get = id => root.querySelector(`#calendar-${id}`);
  const grid = get('grid'), list = get('events');
  const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  let today = kstDateKey(Math.floor(Date.now() / 1000)), month = today.slice(0, 7), selected = today;
  let latest = null, options = {}, identity, gridKey;
  const eventRows = new Map();
  function reset() {
    today = kstDateKey(Math.floor((options.now ?? Date.now()) / 1000)); month = today.slice(0, 7); selected = today; gridKey = undefined; identity = undefined;
    eventRows.clear(); list.replaceChildren();
  }
  function createEventRow(event) {
    const element = document.createElement('li'); element.dataset.kind = event.kind;
    const name = document.createElement('strong'); name.textContent = event.title;
    const time = document.createElement('time'); time.dateTime = new Date(event.at * 1000).toISOString();
    const remaining = document.createElement('p'); remaining.className = 'calendar-remaining muted';
    const details = document.createElement('details'); details.className = 'time-details';
    const summary = document.createElement('summary'); summary.textContent = '정확한 시각';
    const fullTime = document.createElement('p'); fullTime.textContent = formatKst(event.at);
    const fullRemaining = document.createElement('p'); fullRemaining.className = 'muted';
    details.append(summary, fullTime, fullRemaining);
    element.append(name, time, remaining, details);
    return { element, time, remaining, fullRemaining };
  }
  function render() {
    const now = options.now ?? Date.now();
    today = kstDateKey(Math.floor(now / 1000));
    const data = calendarEvents(latest);
    const events = data.events.filter(e => e.date === selected);
    const [year, number] = month.split('-');
    setText(get('month'), `${year}년 ${Number(number)}월`);
    setText(get('selected'), `${selected} 일정 · ${events.length}건`);
    setText(get('status'), !latest ? '조회 후 만료·리셋 일정을 표시합니다.'
      : options.loading ? '재조회 중입니다. 마지막 성공 일정을 표시합니다.'
      : options.stale ? '이전 조회 결과입니다. 최신 일정을 재조회해 주세요.'
      : '마지막 조회 기준 일정입니다. 지난 시각은 새로고침으로 확인하세요.');
    setText(get('queried-at'), latest ? formatKst(latest.queriedAt) : '확인 전');
    setText(get('notes'), data.notes.join(' '));
    const key = JSON.stringify([month, selected, today, data.events]);
    if (key !== gridKey) {
      const focusedDate = grid.contains(document.activeElement) ? document.activeElement.dataset.calendarDate : null;
      gridKey = key; grid.replaceChildren();
      const start = new Date(`${month}-01T00:00:00Z`).getUTCDay();
      for (let i = 0; i < start; i++) { const blank = document.createElement('span'); blank.setAttribute('aria-hidden', 'true'); grid.append(blank); }
      for (const date of monthDates(month)) {
        const events = data.events.filter(e => e.date === date);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'calendar-date';
        button.dataset.calendarDate = date; button.dataset.today = String(date === today);
        button.setAttribute('aria-pressed', String(date === selected));
        button.setAttribute('aria-label', `${date}${date === today ? ' 오늘' : ''}, 일정 ${events.length}건${events.length ? ': ' + events.map(e => e.title).join(', ') : ''}`);
        if (date === today) button.setAttribute('aria-current', 'date');
        const day = document.createElement('span'); day.textContent = String(Number(date.slice(-2))); button.append(day);
        const marks = document.createElement('span'); marks.className = 'calendar-marks'; marks.setAttribute('aria-hidden', 'true');
        for (const kind of [...new Set(events.map(e => e.kind))]) { const mark = document.createElement('span'); mark.dataset.kind = kind; marks.append(mark); }
        if (events.length) { const count = document.createElement('span'); count.className = 'calendar-count'; count.textContent = `${events.length}건`; marks.append(count); }
        button.append(marks); grid.append(button);
      }
      if (focusedDate) grid.querySelector(`[data-calendar-date="${focusedDate}"]`)?.focus();
    }
    const desired = [], occurrences = new Map();
    for (const event of events) {
      const signature = JSON.stringify([event.kind, event.number, event.at, event.title]);
      const ordinal = occurrences.get(signature) ?? 0; occurrences.set(signature, ordinal + 1);
      const rowKey = `${signature}:${ordinal}`;
      let row = eventRows.get(rowKey);
      if (!row) { row = createEventRow(event); eventRows.set(rowKey, row); }
      setText(row.time, formatSummaryTime(event.at, { nowMs: now }));
      setText(row.remaining, formatSummaryRemaining(event.at, { nowMs: now }));
      setText(row.fullRemaining, remainingTime(event.at, now));
      desired.push({ key: rowKey, row });
    }
    const active = document.activeElement;
    let recoverFocus = false;
    const keep = new Set(desired.map(item => item.key));
    for (const [rowKey, row] of eventRows) {
      if (keep.has(rowKey)) continue;
      recoverFocus ||= row.element.contains(active);
      row.element.remove(); eventRows.delete(rowKey);
    }
    let cursor = list.firstChild;
    for (const { row } of desired) {
      if (row.element === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row.element, cursor);
    }
    if (recoverFocus) grid.querySelector(`[data-calendar-date="${selected}"]`)?.focus();
    else if (list.contains(active) && document.activeElement !== active) active.focus();
    get('empty').hidden = events.length > 0;
    setText(get('empty'), !latest ? '조회 후 일정을 확인할 수 있습니다.'
      : data.notes.length ? '이 날짜에 확인된 일정이 없습니다. 아래 데이터 안내를 확인하세요.' : '예정된 만료·리셋이 없습니다.');
  }
  function select(date, focus = false) {
    selected = date; month = date.slice(0, 7); render();
    if (focus) grid.querySelector(`[data-calendar-date="${date}"]`)?.focus();
  }
  get('prev').addEventListener('click', () => select(`${shiftMonth(month, -1)}-01`));
  get('next').addEventListener('click', () => select(`${shiftMonth(month, 1)}-01`));
  get('today').addEventListener('click', () => select(today));
  grid.addEventListener('click', event => { const date = event.target.closest('[data-calendar-date]')?.dataset.calendarDate; if (date) select(date, true); });
  grid.addEventListener('keydown', event => {
    const date = event.target.closest('[data-calendar-date]')?.dataset.calendarDate;
    if (!date) return;
    const at = new Date(`${date}T00:00:00Z`), weekday = at.getUTCDay();
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday }[event.key];
    if (delta === undefined) return;
    event.preventDefault(); at.setUTCDate(at.getUTCDate() + delta); select(at.toISOString().slice(0, 10), true);
  });
  return { reset, update(snapshot, nextOptions = {}) {
    options = nextOptions;
    const nextIdentity = snapshot ? `${snapshot.accountScope}:${snapshot.revision}` : null;
    if (identity !== nextIdentity) reset();
    identity = nextIdentity; latest = snapshot; render();
  } };
}
