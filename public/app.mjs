import { formatKst, remainingTime, emptyMessage } from './time.mjs';
import { initialState, updateState } from './state.mjs';
import { createReminderController } from './notifications.mjs';
import { recommendUsage, buildUsagePlan } from './usage-timing.mjs';
import { createUsagePlanView } from './usage-plan-view.mjs';
import { createUsageAlertController } from './usage-alerts.mjs';
import { createUsageForecastController } from './usage-forecast.mjs';
import { compareStartTimes } from './start-time-comparison.mjs';
import { createUsageReadCoordinator } from './usage-read-coordinator.mjs';
import { createMotionController } from './motion.mjs';
import { createTabController, normalizeTab, tabUrl } from './tabs.mjs';

const elements = Object.fromEntries(['connection', 'refresh', 'notice', 'count', 'nearest', 'nearest-remaining', 'coverage', 'credits', 'queried-at', 'notifications-toggle', 'notifications-status', 'usage-status', 'recommendation', 'recommendation-title', 'recommendation-reason', 'recommendation-target', 'recommendation-remaining', 'recommendation-queried-at', 'recommendation-disclaimer', 'usage-alerts-toggle', 'usage-alerts-status'].map(id => [id, document.getElementById(id)]));
const usageElements = ['five-hour', 'weekly'].map(kind => ({ kind, element: document.getElementById(`usage-${kind}`) }));
const forecastElements = ['five-hour', 'weekly'].map(kind => ({ kind, element: document.getElementById(`forecast-${kind}`) }));
const forecastToggle = document.getElementById('forecast-toggle');
const forecastStatus = document.getElementById('forecast-status');
const comparisonRoot = document.getElementById('start-time-comparison');
const comparisonStatus = document.getElementById('comparison-status');
const comparisonQueriedAt = document.getElementById('comparison-queried-at');
const comparisonElements = ['now', 'five-hour', 'weekly'].map(key => ({ key, element: document.getElementById(`comparison-${key}`) }));
const usageAnnouncement = document.getElementById('usage-announcement');
const usagePanel = document.getElementById('usage-panel');
const tablist = document.getElementById('dashboard-tabs');
const tabElements = [...tablist.querySelectorAll('[role="tab"]')];
const tabPanels = [...document.querySelectorAll('[data-tab-panel]')];
const busyPanels = ['usage-panel', 'recommendation', 'start-time-comparison', 'usage-alerts', 'usage-forecast', 'usage-plan'].map(id => document.getElementById(id));
const planView = createUsagePlanView(document.getElementById('usage-plan-chart'));
const planRate = document.getElementById('usage-plan-rate');
const planModes = [...document.querySelectorAll('[name="usage-plan-rate-mode"]')];
const planError = document.getElementById('usage-plan-input-error');
const planCompact = Object.fromEntries(['summary', 'first-use', 'leftover', 'next-gap'].map(key => [key, document.getElementById(`usage-plan-${key}`)]));
const planNumber = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 6 });
let planMode = 'auto';
let planCache;
let projectionExpiredSnapshot;
const motion = createMotionController();
const announcementKeys = new Map();
const pendingAnnouncements = new Map();
let announcementScheduled = false;
let queryAnnouncementSequence = 0;
let state = initialState();
let renderedSnapshot;
let sessionReady = false;
let reminders;
let usageAlerts;
let forecast;
let activeRefresh;
let readCoordinator;
let pageSuspended = false;
let pageGeneration = 0;
let usageAlertError = '';
let reminderError = '';
let animateSnapshotChanges = false;
const labels = { available: '사용 가능', redeeming: '사용 처리 중', redeemed: '사용 완료', unknown: '상태 확인 불가' };

const tabs = createTabController({
  tablist,
  tabs: tabElements,
  panels: tabPanels,
  initialTab: normalizeTab(new URL(location.href).searchParams.get('tab')),
  motion,
  onSelect: tabId => history.pushState(null, '', tabUrl(location.href, tabId)),
});
addEventListener('popstate', () => tabs.activate(new URL(location.href).searchParams.get('tab'), { notify: false }));

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function setText(element, value, { emphasize = false } = {}) {
  if (element.textContent === value) return false;
  element.textContent = value;
  if (emphasize && animateSnapshotChanges) motion.emphasizeValue(element);
  return true;
}
function announceStatus(category, key, message, announceInitial = true) {
  const seen = announcementKeys.has(category);
  if (seen && announcementKeys.get(category) === key) return;
  announcementKeys.set(category, key);
  pendingAnnouncements.delete(category);
  if (!message || (!seen && !announceInitial)) return;
  pendingAnnouncements.set(category, message);
  if (announcementScheduled) return;
  announcementScheduled = true;
  queueMicrotask(() => {
    announcementScheduled = false;
    const messages = [...pendingAnnouncements.values()]; pendingAnnouncements.clear();
    if (!pageSuspended && messages.length) usageAnnouncement.textContent = messages.join(' ');
  });
}
function dispatch(event) {
  const previousState = state;
  const previousSnapshot = state.snapshot;
  state = updateState(state, event);
  const accountChanged = (previousSnapshot && (!state.snapshot || previousSnapshot.accountScope !== state.snapshot.accountScope || previousSnapshot.revision !== state.snapshot.revision))
    || (state.revision !== previousState.revision && previousState.revision >= 0)
    || (['signed-out', 'unsupported'].includes(state.authState) && state.authState !== previousState.authState)
    || (event.type === 'failure' && event.error.clearPrevious);
  if (accountChanged) clearUsagePlan();
  if (event.type === 'success' && state.snapshot === event.snapshot) projectionExpiredSnapshot = undefined;
  if (reminders) {
    if (event.type === 'success' && state.snapshot === event.snapshot) { reminderError = ''; reminders.update(event.snapshot); }
    else if (event.type === 'failure') {
      if (state.snapshot) reminders.pause();
      else reminders.update(undefined);
    }
    else if (event.type === 'status' && previousSnapshot && !state.snapshot) reminders.update(undefined);
  }
  if (usageAlerts) {
    if (event.type === 'success' && state.snapshot === event.snapshot) { usageAlertError = ''; usageAlerts.update(event.snapshot); }
    else if (event.type === 'failure' || event.type === 'status') {
      if (!state.snapshot) usageAlerts.update(undefined);
      else if (state.usageStale || !state.connected) usageAlerts.pause();
    }
  }
  if (forecast) {
    if (event.type === 'success' && state.snapshot === event.snapshot) forecast.update(event.snapshot);
    else if (event.type === 'failure' || event.type === 'status') {
      if (!state.snapshot) forecast.update(undefined);
      else if (state.usageStale || !state.connected) forecast.pause();
    }
  }
  render();
  if (previousSnapshot && !state.snapshot) {
    pendingAnnouncements.delete('query');
    announceStatus('account', `${state.revision}:${state.authState}`, '계정 상태가 변경되어 이전 사용량 결과를 지웠습니다.');
  } else if (event.type === 'success' && state.snapshot === event.snapshot) {
    if (previousSnapshot && (previousSnapshot.revision !== state.snapshot.revision || previousSnapshot.accountScope !== state.snapshot.accountScope)) {
      announceStatus('account', `${state.snapshot.accountScope}:${state.revision}:${state.authState}`, '계정 상태가 변경되어 이전 사용량 결과를 지우고 현재 계정 정보를 확인했습니다.');
    }
    const balance = kind => {
      const value = state.snapshot.usageWindows?.find(row => row.kind === kind)?.remainingPercent;
      return Number.isInteger(value) && value >= 0 && value <= 100 ? `${value}%` : '확인 불가';
    };
    announceStatus('query', ++queryAnnouncementSequence, `사용량 조회 완료. 5시간 ${balance('five-hour')}, 주간 ${balance('weekly')}. 추천: ${elements['recommendation-title'].textContent}`);
  } else if (event.type === 'failure') {
    announceStatus('query', ++queryAnnouncementSequence, state.snapshot ? '최신 사용량 조회에 실패했습니다. 이전 결과를 표시합니다.' : '사용량을 조회하지 못했습니다. 로그인과 연결 상태를 확인해 주세요.');
  }
}
function render() {
  const ready = state.connected && state.authState === 'chatgpt';
  elements.connection.textContent = ready ? 'Codex 연결됨' : state.authState === 'signed-out' ? '로그인 필요' : state.authState === 'unsupported' ? '인증 방식 확인 필요' : state.connected ? '계정 확인 필요' : '연결 확인 필요';
  elements.connection.dataset.state = ready ? 'ready' : 'waiting';
  elements.refresh.disabled = state.loading || !sessionReady;
  elements.refresh.textContent = state.loading ? '조회 중...' : '새로고침';
  document.body.dataset.loading = String(state.loading);
  if (setText(elements.notice, state.message)) motion.showNotice(elements.notice);
  elements.notice.dataset.kind = state.kind;
  if (reminders) {
    elements['notifications-toggle'].disabled = !sessionReady || !reminders.available || (globalThis.Notification?.permission === 'denied' && !reminders.enabled);
    elements['notifications-toggle'].setAttribute('aria-pressed', String(reminders.enabled));
    elements['notifications-toggle'].textContent = reminders.enabled ? '알림 끄기' : '알림 켜기';
    const reason = reminderError || reminders.reason;
    elements['notifications-status'].textContent = reason || (reminders.enabled
      ? '알림이 켜졌습니다. 이 브라우저 탭이 열려 있을 때만 확인합니다.'
      : '브라우저 탭이 열려 있을 때만 24시간 전·1시간 전에 알려드립니다.');
    announceStatus('reminders', `${reminders.enabled}:${reason}`, reason ? `만료 알림: ${reason}` : '', false);
  }
  if (usageAlerts) {
    elements['usage-alerts-toggle'].disabled = !sessionReady || !usageAlerts.available || (globalThis.Notification?.permission === 'denied' && !usageAlerts.enabled);
    elements['usage-alerts-toggle'].setAttribute('aria-pressed', String(usageAlerts.enabled));
    elements['usage-alerts-toggle'].textContent = usageAlerts.enabled ? '사용량 알림 끄기' : '사용량 알림 켜기';
    elements['usage-alerts-status'].textContent = usageAlertError || usageAlerts.reason || (usageAlerts.enabled
      ? '사용량 알림이 켜졌습니다. 열린 탭에서 발송 전 재조회합니다.'
      : '리셋 30분 전·잔여량 20% 이하·리셋 확인 시 알려드립니다.');
    const reason = usageAlertError || usageAlerts.reason;
    announceStatus('usage-alerts', `${usageAlerts.enabled}:${reason}`, reason ? `사용량 알림: ${reason}` : '', false);
  }
  for (const panel of busyPanels) panel.setAttribute('aria-busy', String(state.loading));
  elements.credits.setAttribute('aria-busy', String(state.loading));
  const snapshot = state.snapshot;
  if (renderedSnapshot !== snapshot) {
    animateSnapshotChanges = Boolean(renderedSnapshot && snapshot);
    renderedSnapshot = snapshot;
    elements.credits.replaceChildren();
    setText(elements.count, snapshot ? String(snapshot.availableCount ?? '확인 불가') : '확인 전', { emphasize: true });
    elements['queried-at'].textContent = snapshot ? formatKst(snapshot.queriedAt) : '확인 전';
    elements.coverage.textContent = snapshot ? emptyMessage(snapshot) : '조회 후 상세 정보를 표시합니다.';
    const nearest = snapshot?.credits.find(c => c.expiryState === 'known');
    elements.nearest.textContent = nearest ? formatKst(nearest.expiresAt) : snapshot ? '확인 가능한 만료 시각이 없습니다.' : '아직 조회하지 않았습니다.';
    for (const credit of snapshot?.credits ?? []) {
      const article = node('article', undefined, 'credit');
      const header = node('div', undefined, 'credit-header');
      const title = node('div');
      title.append(node('span', `리셋권 ${String(credit.number).padStart(2, '0')}`, 'credit-number'), node('h3', credit.title));
      header.append(title, node('span', labels[credit.status] ?? labels.unknown, 'badge'));
      const list = node('dl');
      const expiry = credit.expiryState === 'none' ? '만료 없음' : credit.expiryState === 'unknown' ? '만료 시각 확인 불가' : formatKst(credit.expiresAt);
      list.append(node('dt', '지급 시각'), node('dd', formatKst(credit.grantedAt)), node('dt', '만료 시각'), node('dd', expiry), node('dt', '남은 시간'));
      const remaining = node('dd', '', 'remaining');
      remaining.dataset.number = credit.number;
      list.append(remaining); article.append(header, list); elements.credits.append(article);
    }
  }
  tick();
  animateSnapshotChanges = false;
}
function tick() {
  const snapshot = state.snapshot;
  renderUsage(snapshot);
  renderRecommendation(snapshot);
  renderForecast();
  renderComparison();
  const nearest = snapshot?.credits.find(c => c.expiryState === 'known');
  elements['nearest-remaining'].textContent = nearest ? remainingTime(nearest.expiresAt) : '';
  for (const row of elements.credits.querySelectorAll('.remaining')) {
    const credit = snapshot?.credits.find(c => String(c.number) === row.dataset.number);
    if (!credit) continue;
    row.textContent = credit.expiryState === 'none' ? '만료 없음' : credit.expiryState === 'unknown' ? '만료 시각 확인 불가' : remainingTime(credit.expiresAt);
    row.dataset.expired = String(credit.expiryState === 'known' && credit.expiresAt * 1000 <= Date.now());
  }
}
function renderUsage(snapshot) {
  const now = Date.now();
  let resetPassed = false;
  for (const { kind, element } of usageElements) {
    const row = snapshot?.usageWindows?.find(window => window.kind === kind);
    const percent = row?.remainingPercent;
    const knownPercent = Number.isFinite(percent) && percent >= 0 && percent <= 100;
    setText(element.querySelector('.usage-percent'), knownPercent ? `${percent}%` : snapshot ? '확인 불가' : '확인 전', { emphasize: true });
    const progress = element.querySelector('progress');
    progress.hidden = !knownPercent;
    progress.value = knownPercent ? percent : 0;
    element.querySelector('.usage-reset').textContent = formatKst(row?.resetsAt);
    const hasReset = Number.isSafeInteger(row?.resetsAt);
    const passed = hasReset && row.resetsAt * 1000 <= now;
    if (!state.loading && !state.usageStale) announceStatus(`reset-${kind}`, `${snapshot?.accountScope}:${snapshot?.revision}:${row?.resetsAt}:${passed}`, passed
      ? `${kind === 'five-hour' ? '5시간' : '주간'} 리셋 시각이 지났습니다. 최신 사용량을 재조회해 주세요.` : '');
    resetPassed ||= passed;
    element.querySelector('.usage-remaining').textContent = passed ? '리셋 시각 경과: 새로고침 필요'
      : hasReset ? remainingTime(row.resetsAt, now) : '리셋 시각 확인 불가';
  }
  elements['usage-status'].textContent = !snapshot ? '조회 후 사용 한도를 표시합니다.'
    : state.loading ? '재조회 중입니다. 아래 값은 마지막 성공 결과입니다.'
    : state.usageStale ? '이전 조회 결과입니다. 최신 사용량을 재조회해 주세요.'
    : resetPassed ? '리셋 시각이 지났습니다. 최신 사용량을 재조회해 주세요.'
    : snapshot.usageWindows?.every(row => row.state === 'complete') ? '마지막 조회 기준 잔여율입니다. 실제 사용 가능 여부는 서버 상태에 따라 달라집니다.'
    : '일부 사용 한도 정보를 확인할 수 없습니다. 제공된 값만 표시합니다.';
  if (snapshot?.ordinaryUsageAllowed === false) elements['usage-status'].textContent += ' 마지막 조회에서 서버가 일반 사용을 제한했습니다.';
  usagePanel.dataset.state = !snapshot ? 'not-ready'
    : state.loading ? 'loading'
    : state.usageStale ? 'stale'
    : snapshot.ordinaryUsageAllowed === false ? 'restricted'
    : resetPassed ? 'reset-passed'
    : snapshot.usageWindows?.every(row => row.state === 'complete') ? 'complete'
    : 'partial';
}
function clearUsagePlan() {
  planMode = 'auto';
  planRate.value = '';
  planModes.forEach(input => { input.checked = input.value === 'auto'; });
  planError.textContent = '';
  planRate.setAttribute('aria-invalid', 'false');
  planCache = undefined;
  projectionExpiredSnapshot = undefined;
  planView.clear();
  Object.values(planCompact).forEach(element => { element.textContent = ''; });
}
function usagePlan(snapshot, legacy) {
  const now = Date.now() / 1000;
  const weeklyForecast = forecast?.enabled ? forecast.read().find(row => row.kind === 'weekly') : null;
  const automaticRate = ['forecast', 'reset-first'].includes(weeklyForecast?.state) && Number.isFinite(weeklyForecast.ratePerHour) && weeklyForecast.ratePerHour > 0
    ? weeklyForecast.ratePerHour * 24 : null;
  const manualRate = planRate.valueAsNumber;
  const invalid = planMode === 'manual' && (!planRate.validity.valid || !Number.isFinite(manualRate) || manualRate <= 0);
  const ratePerDay = planMode === 'manual' ? invalid ? null : manualRate : Number.isFinite(automaticRate) ? automaticRate : null;
  // Consumption stays anchored to the successful read. Real-time boundaries
  // suspend the old projection; they never advance its balance reference.
  if (planCache?.snapshot === snapshot && planCache.plan.exhaustsAt > planCache.referenceNow && planCache.plan.exhaustsAt <= now) projectionExpiredSnapshot = snapshot;
  const suspended = ['not-ready', 'refreshing', 'refresh-needed', 'server-restricted', 'incomplete'].includes(legacy.code);
  const boundary = [...(snapshot?.credits ?? []).flatMap(row => row.expiryState === 'known' ? [row.expiresAt - 3600, row.expiresAt] : []),
    ...(snapshot?.usageWindows ?? []).map(row => row.resetsAt)].filter(at => Number.isFinite(at) && at <= now && at >= snapshot?.queriedAt).sort((a, b) => a - b).at(-1);
  const expiredProjection = Boolean(snapshot && projectionExpiredSnapshot === snapshot);
  const key = JSON.stringify([legacy.code, state.loading, state.usageStale, state.connected, state.authState, planMode, planRate.value, invalid,
    weeklyForecast?.state, ratePerDay, boundary, expiredProjection]);
  if (!planCache || planCache.snapshot !== snapshot || planCache.key !== key) {
    const referenceNow = suspended || expiredProjection ? now : snapshot?.queriedAt ?? now;
    let plan = buildUsagePlan(snapshot, { now: referenceNow, refreshing: state.loading,
      stale: state.usageStale || !state.connected || state.authState !== 'chatgpt' || expiredProjection,
      ratePerDay, rateSource: planMode });
    if (plan.state === 'ready' && plan.exhaustsAt > referenceNow && plan.exhaustsAt <= now) {
      projectionExpiredSnapshot = snapshot;
      plan = buildUsagePlan(snapshot, { now, stale: true, rateSource: planMode });
    }
    const first = plan.firstCredit;
    if (plan.state === 'ready' && first && ((first.deadlineAt > referenceNow && first.deadlineAt <= now) || first.expiresAt <= now)) {
      plan = { ...buildUsagePlan(snapshot, { now, stale: true, rateSource: planMode }),
        title: '리셋권 마감 후 재조회가 필요합니다.',
        reason: '첫 리셋권 안전 마감 또는 만료 시각이 지났습니다. 이전 잔여량으로 계획하지 않고 최신 상태를 재조회한 뒤 사용 여부를 검토하세요.' };
    }
    if (invalid && plan.state === 'ready') {
      plan = { ...plan, state: 'incomplete', code: 'invalid-rate', title: '예상 하루 소모량을 확인해 주세요.',
        reason: '0보다 큰 유한한 숫자를 입력하면 사용 계획을 안내합니다.' };
    }
    if (plan.state !== 'ready') {
      plan = { ...plan, targetAt: null, ratePerDay: null, requiredRatePerDay: null, exhaustsAt: null, remainingAtTarget: null,
        firstCredit: null, nextCredit: null, firstUseAt: null, nextGapSeconds: null, nextRequiredRatePerDay: null, nextRemainingPercent: null,
        events: [], segments: [], warnings: [] };
    } else if (planMode === 'auto' && ratePerDay !== null) {
      plan = { ...plan, warnings: [...plan.warnings, '자동 소모량은 최근 30분 성공 표본의 속도를 하루 24시간으로 확장한 낙관적 예상입니다.'] };
    }
    planCache = { key, snapshot, plan, referenceNow };
  }
  planRate.disabled = planMode === 'auto';
  const fieldError = planCache.plan.code === 'invalid-rate';
  planRate.setAttribute('aria-invalid', String(fieldError));
  setText(planError, fieldError ? '0보다 큰 유한한 숫자를 입력해 주세요.' : '');
  return planCache.plan;
}
function renderRecommendation(snapshot) {
  const legacy = recommendUsage(snapshot, { refreshing: state.loading, stale: state.usageStale || !state.connected || state.authState !== 'chatgpt' });
  const plan = usagePlan(snapshot, legacy);
  const recommendation = plan.firstCredit || ['invalid-rate', 'refresh-needed'].includes(plan.code) || projectionExpiredSnapshot === snapshot && snapshot ? plan : legacy;
  planView.update(plan);
  const readyPlan = plan.state === 'ready' && plan.firstCredit !== null;
  setText(planCompact.summary, readyPlan ? `주간 목표까지 필요한 소모량: ${plan.requiredRatePerDay === null ? '즉시 재조회 필요' : `${planNumber.format(plan.requiredRatePerDay)} %p/일`}` : '');
  setText(planCompact['first-use'], readyPlan && plan.firstUseAt !== null ? `${plan.ratePerDay === null ? '첫 리셋권 안전 마감 (소진 예상 아님)' : '첫 리셋권 사용 검토'}: ${formatKst(Math.floor(plan.firstUseAt))}` : '');
  setText(planCompact.leftover, readyPlan && plan.remainingAtTarget !== null ? `목표 시점 예상 잔여: ${planNumber.format(plan.remainingAtTarget)}%` : '');
  setText(planCompact['next-gap'], readyPlan && plan.nextGapSeconds !== null ? `첫 사용 검토 → 다음 안전 마감: ${planNumber.format(plan.nextGapSeconds / 3600)}시간` : '');
  elements.recommendation.dataset.code = recommendation.code;
  setText(elements['recommendation-title'], recommendation.title, { emphasize: true });
  elements['recommendation-reason'].textContent = recommendation.reason;
  setText(elements['recommendation-target'], recommendation.targetAt === null ? snapshot ? '해당 없음' : '확인 전' : formatKst(recommendation.targetAt), { emphasize: true });
  elements['recommendation-remaining'].textContent = recommendation.targetAt === null ? '' : remainingTime(recommendation.targetAt);
  elements['recommendation-queried-at'].textContent = snapshot ? formatKst(snapshot.queriedAt) : '확인 전';
  const actionable = ['ready', 'weekly-budget', 'weekly-reset', 'five-hour-reset', 'credit-deadline', 'credit-before-expiry', 'credit-after-depletion', 'natural-reset-first'].includes(recommendation.code);
  elements['recommendation-disclaimer'].textContent = actionable
    ? '잔여량을 활용하기 위한 권고이며, 작업 횟수나 사용 가능 시간을 보장하지 않습니다.'
    : '최신 상태를 확인한 뒤 사용 시점을 다시 안내합니다.';
  const expired = snapshot?.usageWindows?.some(row => Number.isSafeInteger(row.resetsAt) && row.resetsAt * 1000 <= Date.now());
  announceStatus('recommendation', `${snapshot?.accountScope}:${recommendation.code}`, recommendation.code === 'refresh-needed' && !expired && !state.usageStale
    ? recommendation.title : '', false);
}
function renderForecast() {
  const enabled = forecast?.enabled ?? false;
  forecastToggle.disabled = !sessionReady;
  forecastToggle.textContent = enabled ? '추세 끄기' : '추세 켜기';
  forecastToggle.setAttribute('aria-pressed', String(enabled));
  forecastStatus.textContent = enabled ? '화면이 보일 때 5분마다 조회합니다. 최근 30분의 성공 조회를 메모리에만 보관합니다.'
    : '추세를 켜면 사용 속도와 예상 소진 시각을 계산합니다. 종료·새로고침 시 이력을 삭제합니다.';
  const messages = {
    unavailable: '사용 한도 정보를 확인할 수 없습니다.', collecting: '서로 다른 시각의 성공 조회가 3건 이상 필요합니다.',
    'no-decrease': '잔여량 감소가 없어 소진 시점을 예측하지 않습니다.', exhausted: '마지막 조회 기준 잔여량이 0%입니다.',
    'reset-first': '현재 추세로 리셋 전 소진 예상이 없습니다.', forecast: '최근 사용 속도가 유지될 때의 추정입니다.',
    stale: '최신 조회에 실패했습니다. 다음 성공 조회까지 예측을 보류합니다.', 'reset-passed': '리셋 시각이 지났습니다. 재조회가 필요합니다.',
    'estimate-passed': '예상 소진 시각이 지났습니다. 실제 상태를 재조회해 주세요.',
  };
  const rows = enabled ? forecast.read() : [];
  for (const { kind, element } of forecastElements) {
    const row = rows.find(row => row.kind === kind);
    element.dataset.state = row?.state ?? 'off';
    element.querySelector('.forecast-state').textContent = row ? messages[row.state] : '추세를 켜면 조회 이력을 수집합니다.';
    element.querySelector('.forecast-rate').textContent = Number.isFinite(row?.ratePerHour) ? `${row.ratePerHour.toFixed(1)}%p/시간` : '계산 전';
    element.querySelector('.forecast-exhaustion').textContent = row?.exhaustsAt != null ? formatKst(row.exhaustsAt) : '계산 전';
    element.querySelector('.forecast-samples').textContent = `최근 30분 성공 조회 ${row?.samples ?? 0}건`;
    const informative = row && ['forecast', 'stale', 'reset-passed', 'estimate-passed'].includes(row.state);
    const message = informative ? `${kind === 'five-hour' ? '5시간' : '주간'} 추세: ${messages[row.state]}${row.state === 'forecast' ? ` 예상 소진 시각 ${formatKst(row.exhaustsAt)}` : ''}` : '';
    announceStatus(`forecast-${kind}`, `${state.snapshot?.accountScope}:${row?.resetsAt}:${row?.state ?? 'off'}`, message);
  }
}
function renderComparison() {
  const comparison = compareStartTimes(state.snapshot, { refreshing: state.loading, stale: state.usageStale || !state.connected || state.authState !== 'chatgpt' });
  const names = { 'five-hour': '5시간', weekly: '주간' };
  comparisonRoot.dataset.state = comparison.state;
  comparisonStatus.textContent = comparison.message;
  comparisonQueriedAt.textContent = comparison.queriedAt === null ? '확인 전' : formatKst(comparison.queriedAt);
  for (const { key, element } of comparisonElements) {
    const row = comparison.rows.find(row => row.key === key);
    const suspended = ['not-ready', 'refresh-needed', 'refreshing'].includes(row.state);
    element.dataset.state = row.state;
    element.querySelector('.comparison-time').textContent = row.startAt === null ? '확인 불가' : formatKst(row.startAt);
    element.querySelector('.comparison-wait').textContent = row.startAt === null ? '' : key === 'now' ? '지금' : remainingTime(row.startAt);
    element.querySelector('.comparison-resets').textContent = suspended ? '리셋 정보는 재조회 후 확인합니다.'
      : key === 'now' ? '현재 조회된 한도 기준'
      : row.startAt === null ? '리셋 시각 확인 불가'
      : `이 시각까지 예정된 리셋 (이번 조회): ${row.resetKinds.map(kind => names[kind]).join(' · ') || '확인 불가'}`;
    const limits = row.carriedLimits.map(limit => `${names[limit.kind]} ${limit.remainingPercent === null ? '확인 불가' : `${limit.remainingPercent}%`}`).join(' · ');
    element.querySelector('.comparison-limits').textContent = suspended ? '한도 정보는 재조회 후 확인합니다.'
      : limits ? `${key === 'now' ? '잔여량' : '아직 리셋 예정이 아닌 한도'} (마지막 조회 기준): ${limits}`
      : '이 시각 이후에 예정된 리셋: 없음 (이번 조회 기준)';
    element.querySelector('.comparison-message').textContent = row.message;
  }
}
async function api(path, { method = 'GET', data } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(17000),
    headers: { 'X-Reset-Check': '1', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(data ?? {}) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw result;
  return result;
}
function failure(error) {
  return typeof error?.message === 'string' && typeof error?.code === 'string' ? error : { code: 'CONNECTION', message: '로컬 서버에 연결하지 못했습니다. 앱 실행 상태를 확인해 주세요.', clearPrevious: false };
}
async function refresh() {
  if (!sessionReady) return null;
  return refreshSnapshot();
}
async function refreshSnapshot() {
  if (!sessionReady || pageSuspended) return null;
  if (activeRefresh) return activeRefresh;
  const expectedGeneration = pageGeneration;
  const run = (async () => {
    dispatch({ type: 'loading' });
    try {
      const snapshot = await readCoordinator.run();
      if (pageSuspended || expectedGeneration !== pageGeneration) return null;
      dispatch({ type: 'success', snapshot });
      return state.snapshot === snapshot ? snapshot : null;
    }
    catch (error) {
      if (pageSuspended || expectedGeneration !== pageGeneration) return null;
      dispatch({ type: 'failure', error: failure(error) });
      await pollStatus();
      return null;
    }
  })();
  const active = run.finally(() => { if (activeRefresh === active) activeRefresh = undefined; });
  activeRefresh = active;
  return active;
}
async function pollStatus() {
  if (!sessionReady || state.loading || pageSuspended) return;
  const expectedGeneration = pageGeneration;
  try {
    const status = await api('/api/status');
    if (!pageSuspended && expectedGeneration === pageGeneration) dispatch({ type: 'status', status });
  }
  catch {
    if (pageSuspended || expectedGeneration !== pageGeneration) return;
    state = { ...state, connected: false, usageStale: Boolean(state.snapshot) }; usageAlerts?.pause(); forecast?.pause(); render();
  }
}
async function start() {
  const currentUrl = new URL(location.href);
  const token = currentUrl.hash.slice(1);
  const initialTab = normalizeTab(currentUrl.searchParams.get('tab'));
  history.replaceState(null, '', tabUrl(currentUrl.href, initialTab));
  tabs.activate(initialTab, { notify: false, animate: false });
  try {
    if (token) await api('/api/session', { method: 'POST', data: { token } });
    else await api('/api/status');
    sessionReady = true;
    readCoordinator = createUsageReadCoordinator({ locks: globalThis.navigator?.locks, BroadcastChannel: globalThis.BroadcastChannel,
      read: () => api('/api/reset-credits/read', { method: 'POST' }) });
    reminders = createReminderController({
      storage: (() => { try { return globalThis.localStorage; } catch { return null; } })(),
      locks: globalThis.navigator?.locks,
      Notification: globalThis.Notification,
      crypto: globalThis.crypto,
      refresh: refreshSnapshot,
      onError: () => { reminderError = '알림을 확인하지 못했습니다. 브라우저 저장소와 설정을 확인해 주세요.'; render(); },
    });
    usageAlerts = createUsageAlertController({
      storage: (() => { try { return globalThis.localStorage; } catch { return null; } })(),
      locks: globalThis.navigator?.locks, Notification: globalThis.Notification, crypto: globalThis.crypto,
      refresh: refreshSnapshot, onError: () => { usageAlertError = '알림을 확인하지 못했습니다. 브라우저 저장소와 설정을 확인해 주세요.'; render(); },
    });
    forecast = createUsageForecastController({ refresh: refreshSnapshot, onChange: () => { renderForecast(); renderRecommendation(state.snapshot); } });
    await refresh();
    reminders.restore();
    usageAlerts.restore();
    render();
    setInterval(pollStatus, 5000);
  } catch {
    readCoordinator?.close();
    dispatch({ type: 'failure', error: { code: 'SESSION', message: '앱에서 열린 브라우저로 접속해 주세요. 터미널에서 앱을 종료한 뒤 npm start로 다시 실행할 수 있습니다.', clearPrevious: true } });
  }
}
elements.refresh.addEventListener('click', refresh);
elements['notifications-toggle'].addEventListener('click', async () => {
  reminderError = '';
  if (reminders?.enabled) reminders.disable();
  else if (reminders) await reminders.requestEnable();
  render();
});
elements['usage-alerts-toggle'].addEventListener('click', async () => {
  usageAlertError = '';
  if (usageAlerts?.enabled) usageAlerts.disable();
  else if (usageAlerts) await usageAlerts.requestEnable();
  render();
});
forecastToggle.addEventListener('click', () => { if (forecast?.enabled) forecast.disable(); else forecast?.enable(); });
planModes.forEach(input => input.addEventListener('change', () => { planMode = input.value; renderRecommendation(state.snapshot); }));
planRate.addEventListener('input', () => renderRecommendation(state.snapshot));
document.addEventListener('visibilitychange', () => forecast?.visibilityChanged());
addEventListener('storage', event => {
  if (event.key === null || event.key === 'reset-check.reminders.enabled.v1') {
    reminders?.restore();
    render();
  }
  if (event.key === null || event.key === 'reset-check.usage-alerts.enabled.v1') { usageAlerts?.restore(); render(); }
});
addEventListener('pagehide', event => {
  pageSuspended = true; pageGeneration++;
  motion.cancelAll();
  usageAlerts?.pause();
  if (event.persisted) forecast?.suspend();
  else { forecast?.disable(); readCoordinator?.close(); }
});
addEventListener('pageshow', event => {
  if (!event.persisted) return;
  pageSuspended = false; forecast?.resume();
  const reload = () => { if (!pageSuspended) void refresh(); };
  if (activeRefresh) void activeRefresh.then(reload, reload);
  else reload();
});
setInterval(tick, 1000);
start();
