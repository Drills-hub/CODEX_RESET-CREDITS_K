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
    root.append(title, reason, metrics, warnings, events.figure, segments.figure, empty);
    container.append(root);
    return { root, title, reason, values, warnings, events, segments, empty };
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
    const segmentLabels = segments.map(segment => `${segment.kind === 'scenario' ? '100% 충전 시나리오 (보장되지 않음)' : '현재 잔여량 소모 예상'}: ${timestamp(segment.fromAt)} → ${timestamp(segment.toAt)} · ${percent(segment.fromPercent)} → ${percent(segment.toPercent)}`);
    const warnings = plan.warnings || [];
    const visible = JSON.stringify([plan.state, plan.title, plan.reason, values, warnings, events, segments]);
    if (visible === signature) return;
    signature = visible;
    display ||= scaffold();
    display.root.dataset.state = plan.state;
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
      ? '실선: 현재 잔여량의 소모 예상 · 점선: 리셋권 사용 후 주간 100% 충전 가정. 실제 충전 결과와 사용 권한은 다시 조회해야 합니다.'
      : '실선: 현재 조회된 잔여량의 소모 예상입니다. 실제 잔여량과 사용 권한은 다시 조회해야 합니다.');
    const remaining = [
      ['title', { id: `${id}-segments-title` }, hasScenario ? '주간 잔여량 예상과 100% 충전 가정' : '주간 잔여량 소모 예상'],
      ['desc', { id: `${id}-segments-desc` }, segmentLabels.join('\n')],
    ];
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
