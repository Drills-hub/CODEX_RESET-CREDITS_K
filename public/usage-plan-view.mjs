import { formatKst } from './time.mjs';

const svgNamespace = 'http://www.w3.org/2000/svg';
const left = 44;
const right = 384;
let viewNumber = 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => finite(value) ? formatKst(Math.floor(value)) : '확인 불가';
const numberFormatter = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 6 });
const number = value => finite(value) ? numberFormatter.format(value) : '확인 불가';
const rate = value => finite(value) ? `${number(value)} %p/일` : '계산할 속도 없음';
const percent = value => finite(value) ? `${number(value)}%` : '계산 불가';
const coverageLabels = { complete: '전체 상세 조회', partial: '조회된 항목 중', 'count-only': '개수만 제공', unavailable: '정보 미제공' };

// Reconcile SVG children in place: clock updates must not replace the chart
// or its segment nodes. All labels are text, never parsed HTML.
function draw(svg, specs) {
  specs.forEach(([tag, attributes, text = ''], index) => {
    let child = svg.children[index];
    if (child?.localName !== tag) {
      const replacement = svg.ownerDocument.createElementNS(svgNamespace, tag);
      if (child) child.replaceWith(replacement);
      else svg.append(replacement);
      child = replacement;
    }
    for (const attr of [...child.attributes]) {
      if (!(attr.name in attributes)) child.removeAttribute(attr.name);
    }
    for (const [name, value] of Object.entries(attributes)) {
      if (child.getAttribute(name) !== String(value)) child.setAttribute(name, String(value));
    }
    if (child.textContent !== text) child.textContent = text;
  });
  while (svg.children.length > specs.length) svg.lastElementChild.remove();
}

export function createUsagePlanView(container) {
  const document = container.ownerDocument;
  const id = `usage-plan-view-${++viewNumber}`;
  let display = null;
  let signature = null;
  let destroyed = false;

  function node(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }
  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }
  function list(element, strings) {
    const key = JSON.stringify(strings);
    if (element.dataset.content === key) return;
    element.replaceChildren(...strings.map(text => node('li', '', text)));
    element.dataset.content = key;
    element.hidden = strings.length === 0;
  }
  function figure(name, title) {
    const figure = node('figure', 'usage-plan-figure');
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-labelledby', `${id}-${name}-title`);
    svg.setAttribute('aria-describedby', `${id}-${name}-desc`);
    const range = node('p', 'usage-plan-range');
    const textList = node(name === 'events' ? 'ol' : 'ul', name === 'events' ? 'usage-plan-event-list' : 'usage-plan-segment-list');
    const note = node('p', 'usage-plan-chart-note', name === 'events'
      ? '번호에 해당하는 일정을 아래에서 확인하세요. 점선 표시는 가정입니다. 리셋·만료 일정은 사용 허용이나 충전을 보장하지 않습니다.'
      : '실선: 현재 잔여량의 소모 예상 · 점선: 리셋권 사용 후 주간 100% 충전 가정. 실제 충전 결과와 사용 권한은 다시 조회해야 합니다.');
    figure.append(node('figcaption', '', title), svg, range, note, textList);
    return { figure, svg, range, textList, note };
  }
  function scaffold() {
    const root = node('div', 'usage-plan-view');
    const title = node('h3');
    const reason = node('p', 'usage-plan-reason');
    const metrics = node('dl', 'usage-plan-metrics');
    const labels = ['현재 소모량 목표 시각', '예상 하루 소모량', '목표까지 필요한 소모량', '목표 시점 예상 잔여량', '소모량 출처', '조회 범위', '첫 리셋권 사용 검토 시각', '첫 사용 검토부터 다음 안전 마감까지', '100% 충전 가정 · 다음 마감까지 필요한 소모량', '100% 충전 가정 · 다음 마감 예상 잔여량', '마지막 조회'];
    const values = labels.map(label => {
      const group = node('div');
      const value = node('dd');
      group.append(node('dt', '', label), value);
      metrics.append(group);
      return value;
    });
    const warnings = node('ul', 'usage-plan-warnings');
    warnings.setAttribute('aria-label', '계획 주의사항');
    const events = figure('events', '리셋·리셋권 일정');
    const segments = figure('segments', '주간 잔여량 예상');
    const empty = node('p', 'usage-plan-empty');
    const schedule = node('div', 'work-plan-details');
    root.append(title, reason, metrics, schedule, warnings, events.figure, segments.figure, empty);
    container.append(root);
    return { root, title, reason, metrics, schedule, values, warnings, events, segments, empty };
  }

  function update(plan) {
    if (destroyed) return;
    if (!plan) { clear(); return; }
    const events = (plan.events || []).filter(event => finite(event.at));
    const segments = (plan.segments || []).filter(segment =>
      finite(segment.fromAt) && finite(segment.toAt) && segment.fromAt <= segment.toAt
      && finite(segment.fromPercent) && finite(segment.toPercent));
    const values = [
      timestamp(plan.targetAt), rate(plan.ratePerDay), rate(plan.requiredRatePerDay), percent(plan.remainingAtTarget),
      plan.rateSource === 'manual' ? '직접 입력' : '사용 추세에서 자동', coverageLabels[plan.coverage] || '정보 미제공',
      finite(plan.firstUseAt) ? timestamp(plan.firstUseAt) : '해당 없음 · 리셋 후 재조회 또는 정보 확인',
      finite(plan.nextGapSeconds) ? `${number(plan.nextGapSeconds / 3600)}시간` : '계산 불가',
      rate(plan.nextRequiredRatePerDay), percent(plan.nextRemainingPercent), timestamp(plan.queriedAt),
    ];
    const eventLabels = events.map(event => `${event.label}${event.creditNumber === null ? '' : ` · 리셋권 ${event.creditNumber}번`}${event.assumed ? ' (가정 · 재조회 후 검토)' : ' (조회된 일정)'}`);
    const segmentLabels = segments.map(segment => `${segment.kind === 'scenario' ? plan.schedule ? '미래 복구·소모 가정 (보장되지 않음)' : '100% 충전 시나리오 (보장되지 않음)' : '현재 잔여량 소모 예상'}: ${timestamp(segment.fromAt)} → ${timestamp(segment.toAt)} · ${percent(segment.fromPercent)} → ${percent(segment.toPercent)}`);
    const warnings = plan.warnings || [];
    const visible = JSON.stringify([plan.state, plan.title, plan.reason, values, warnings, events, segments, plan.schedule]);
    if (visible === signature) return;
    signature = visible;
    display ||= scaffold();
    display.root.dataset.state = plan.state;
    display.metrics.hidden = Boolean(plan.schedule);
    display.schedule.hidden = !plan.schedule;
    if (plan.schedule) {
      display.schedule.dataset.scheduleState = plan.state;
      const s = plan.schedule;
      const metrics = node('dl', 'usage-plan-metrics');
      const pairs = [
        [`${s.reviewCreditNumber ? `${s.reviewCreditNumber}번 리셋권 ` : ''}권장 검토 구간`, `${timestamp(s.recommendedStart)} ~ ${timestamp(s.recommendedEnd)}`],
        ['최종 접속 마감', timestamp(s.lastSafeAt)],
        ['다음 리셋권 검토', timestamp(s.nextUseAt)],
        ['주간 소모 속도', finite(s.weeklyPerHour) ? `${number(s.weeklyPerHour)} %p/작업시간` : '측정 또는 입력 필요'],
        ['5시간 소모 속도', finite(s.fiveHourPerHour) ? `${number(s.fiveHourPerHour)} %p/작업시간` : '병목 속도 확인 불가'],
        ['검토 대상의 기존량 포기 예상', percent(s.reviewRemainingPercent ?? s.firstRemainingPercent)],
        ['누적 사용 예상량 (여러 주간량)', finite(s.totalUsedPercent) ? `${number(s.totalUsedPercent)} %p` : '계산 전'],
        ['리셋으로 포기할 누적량', finite(s.totalDiscardedPercent) ? `${number(s.totalDiscardedPercent)} %p` : '계산 전'],
        [s.fiveHourPerHour === null ? '주간 제약의 중단 시간 (5시간 병목 미확인)' : '계산한 한도에 따른 중단 작업 시간', finite(s.blockedWorkHours) ? `${number(s.blockedWorkHours)}시간` : '계산 전'],
        ['계획에서 미사용 소멸 위험', finite(s.expiredCredits) ? `${number(s.expiredCredits)}개` : '확인 필요'],
      ];
      for (const [label, text] of pairs) { const group = node('div'); group.append(node('dt', '', label), node('dd', '', text)); metrics.append(group); }
      const slots = node('ul', 'usage-plan-event-list');
      for (const slot of s.workSlots ?? []) slots.append(node('li', '', `작업: ${timestamp(slot.startAt)} → ${timestamp(slot.endAt)}`));
      const assumptions = node('p', 'usage-plan-chart-note', '작업 외 시간은 소비하지 않습니다. 자연 리셋·리셋권 복구는 가정이며 사용 직전에 재조회하세요. 누적 %p는 여러 주간량의 합이지 현재 잔여율이 아닙니다.');
      const table = node('table', 'work-scenario-table');
      table.append(node('caption', '', '속도 민감도 비교 (통계적 신뢰구간 아님)'));
      const header = node('tr'); ['속도', '누적 사용 %p', '포기 %p', '미사용 위험'].forEach(text => header.append(node('th', '', text)));
      const head = node('thead'); head.append(header); table.append(head);
      const body = node('tbody');
      for (const row of s.scenarios ?? []) { const tr = node('tr'); [row.label, number(row.totalUsedPercent), number(row.totalDiscardedPercent), finite(row.expiredCredits) ? `${row.expiredCredits}개` : '확인 필요'].forEach(text => tr.append(node('td', '', text))); body.append(tr); }
      table.append(body);
      const candidates = node('table', 'work-scenario-table');
      candidates.append(node('caption', '', '평가한 사용 후보 (최대 5개, 가정 기반)'));
      const ch = node('tr'); ['검토 시각', '사용 %p', '포기 %p', '미사용 위험'].forEach(text => ch.append(node('th', '', text)));
      const chead = node('thead'); chead.append(ch); candidates.append(chead);
      const cb = node('tbody');
      for (const row of (s.candidates ?? []).slice(0, 5)) { const tr = node('tr'); [timestamp(row.firstUseAt ?? row.nextUseAt), number(row.totalUsedPercent), number(row.totalDiscardedPercent), finite(row.expiredCredits) ? `${row.expiredCredits}개` : '확인 필요'].forEach(text => tr.append(node('td', '', text))); cb.append(tr); }
      candidates.append(cb);
      display.schedule.replaceChildren(metrics, slots, assumptions, table, candidates);
    } else { display.schedule.replaceChildren(); delete display.schedule.dataset.scheduleState; }
    setText(display.title, plan.title);
    setText(display.reason, plan.reason);
    values.forEach((text, index) => setText(display.values[index], text));
    setText(display.values[6].previousElementSibling, finite(plan.ratePerDay)
      ? '첫 리셋권 사용 검토 시각' : '첫 리셋권 안전 마감 · 소진 예상 아님');
    display.values[8].parentElement.hidden = !finite(plan.nextRequiredRatePerDay);
    display.values[9].parentElement.hidden = !finite(plan.nextRemainingPercent);
    list(display.warnings, warnings);

    const times = [...events.map(event => event.at), ...segments.flatMap(segment => [segment.fromAt, segment.toAt])];
    const from = times.length ? Math.min(...times) : null;
    const to = times.length ? Math.max(...times) : null;
    const x = time => from === to ? (left + right) / 2 : left + Math.max(0, Math.min(1, (time - from) / (to - from))) * (right - left);
    const range = from === null ? '' : `${timestamp(from)} → ${timestamp(to)}`;
    display.events.figure.hidden = events.length === 0;
    display.segments.figure.hidden = segments.length === 0;
    display.empty.hidden = events.length > 0 && segments.length > 0;
    setText(display.empty, !events.length ? '표시할 수 있는 일정이 없습니다. 최신 정보를 조회하세요.' : !segments.length ? '유효한 소모 속도나 충전 효과가 없어 잔여량 구간을 그리지 않습니다.' : '');
    setText(display.events.range, range);
    setText(display.segments.range, range);

    const timelineHeight = 70 + events.length * 26;
    display.events.svg.setAttribute('viewBox', `0 0 400 ${timelineHeight}`);
    const timeline = [
      ['title', { id: `${id}-events-title` }, '리셋·리셋권 일정 타임라인'],
      ['desc', { id: `${id}-events-desc` }, events.map((event, index) => `${index + 1}. ${eventLabels[index]} · ${timestamp(event.at)}`).join('\n')],
      ['line', { x1: left, x2: right, y1: timelineHeight - 18, y2: timelineHeight - 18, class: 'usage-plan-axis' }],
    ];
    events.forEach((event, index) => {
      const at = x(event.at);
      const y = 24 + index * 26;
      timeline.push(
        ['line', { x1: at, x2: at, y1: y + 11, y2: timelineHeight - 18, class: 'usage-plan-event-guide' }],
        ['circle', { cx: at, cy: y, r: 11, class: 'usage-plan-event-marker', 'data-event-kind': event.kind, 'data-assumed': event.assumed }],
        ['text', { x: at, y, class: 'usage-plan-event-number' }, String(index + 1)],
      );
    });
    draw(display.events.svg, timeline);
    const eventKey = JSON.stringify([eventLabels, events.map(event => timestamp(event.at))]);
    if (display.events.textList.dataset.content !== eventKey) {
      display.events.textList.replaceChildren(...events.map((event, index) => {
        const row = node('li', '', eventLabels[index]);
        const time = node('time', '', timestamp(event.at));
        const date = new Date(event.at * 1000);
        if (finite(date.getTime())) time.dateTime = date.toISOString();
        row.append(time);
        return row;
      }));
      display.events.textList.dataset.content = eventKey;
    }

    display.segments.svg.setAttribute('viewBox', '0 0 400 208');
    const hasScenario = segments.some(segment => segment.kind === 'scenario');
    setText(display.segments.note, hasScenario
      ? plan.schedule ? '실선: 현재 조회량에 따른 소비 예상. 점선: 자연 리셋 또는 리셋권 복구가 포함된 가정. 5시간 복구와 주간 복구는 다르며 실제 효과와 사용 권한은 재조회해야 합니다.' : '실선: 현재 잔여량의 소모 예상 · 점선: 리셋권 사용 후 주간 100% 충전 가정. 실제 충전 결과와 사용 권한은 다시 조회해야 합니다.'
      : '실선: 현재 조회된 잔여량의 소모 예상입니다. 실제 잔여량과 사용 권한은 다시 조회해야 합니다.');
    const remaining = [
      ['title', { id: `${id}-segments-title` }, hasScenario ? plan.schedule ? '주간 잔여량과 미래 복구 가정' : '주간 잔여량 예상과 100% 충전 가정' : '주간 잔여량 소모 예상'],
      ['desc', { id: `${id}-segments-desc` }, segmentLabels.join('\n')],
    ];
    for (const slot of plan.schedule?.workSlots ?? []) {
      if (finite(slot.startAt) && finite(slot.endAt) && slot.startAt < slot.endAt) remaining.push(['rect', {
        x: x(slot.startAt), y: 24, width: Math.max(0, x(slot.endAt) - x(slot.startAt)), height: 160, class: 'work-band',
      }]);
    }
    for (const [value, y] of [[100, 24], [50, 104], [0, 184]]) {
      remaining.push(
        ['line', { x1: left, x2: right, y1: y, y2: y, class: 'usage-plan-grid' }],
        ['text', { x: 0, y: y + 5, class: 'usage-plan-tick' }, `${value}%`],
      );
    }
    const y = value => 184 - Math.max(0, Math.min(100, value)) * 1.6;
    segments.forEach(segment => remaining.push(['line', {
      x1: x(segment.fromAt), x2: x(segment.toAt), y1: y(segment.fromPercent), y2: y(segment.toPercent),
      class: segment.kind === 'scenario' ? 'usage-plan-scenario' : 'usage-plan-estimate', 'data-segment-kind': segment.kind,
    }]));
    draw(display.segments.svg, remaining);
    list(display.segments.textList, segmentLabels);
  }

  function clear() {
    display?.root.remove();
    display = null;
    signature = null;
  }
  function destroy() {
    clear();
    destroyed = true;
  }
  return { update, clear, destroy };
}
