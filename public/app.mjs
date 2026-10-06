import { formatKst, remainingTime, emptyMessage } from './time.mjs';
import { initialState, updateState } from './state.mjs';
import { createReminderController } from './notifications.mjs';
import { recommendReset } from './reset-recommendation.mjs';
import { formatSummaryTime, formatSummaryRemaining, buildRecommendationDisplay } from './display.mjs';
import { createCalendarView } from './calendar-view.mjs';
import { createUsageAlertController } from './usage-alerts.mjs';
import { createUsageReadCoordinator } from './usage-read-coordinator.mjs';
import { createMotionController } from './motion.mjs';
import { createTabController, normalizeTab, tabUrl } from './tabs.mjs';

const elements = Object.fromEntries(['connection', 'refresh', 'notice', 'count', 'nearest', 'nearest-remaining', 'coverage', 'credits', 'queried-at', 'queried-at-full', 'query-state', 'notifications-toggle', 'notifications-status', 'usage-status', 'recommendation', 'recommendation-title', 'recommendation-reason', 'recommendation-detail-reason', 'recommendation-target', 'recommendation-remaining', 'recommendation-scope-note', 'recommendation-urgency', 'recommendation-disclaimer', 'usage-alerts-toggle', 'usage-alerts-status'].map(id => [id, document.getElementById(id)]));
const usageElements = ['five-hour', 'weekly'].map(kind => ({ kind, element: document.getElementById(`usage-${kind}`) }));
const usageAnnouncement = document.getElementById('usage-announcement');
const usagePanel = document.getElementById('usage-panel');
const tablist = document.getElementById('dashboard-tabs');
const tabElements = [...tablist.querySelectorAll('[role="tab"]')];
const tabPanels = [...document.querySelectorAll('[data-tab-panel]')];
const busyPanels = ['usage-panel', 'recommendation', 'usage-alerts', 'expiry-calendar'].map(id => document.getElementById(id));
const calendar = createCalendarView(document.getElementById('expiry-calendar'));
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
let activeRefresh;
let readCoordinator;
let pageSuspended = false;
let pageGeneration = 0;
let usageAlertError = '';
let reminderError = '';
let animateSnapshotChanges = false;
let settledRecommendationTitle;
const badgeTones = { available: 'success', redeeming: 'warning', redeemed: 'neutral' };
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
  if (accountChanged) calendar.reset();
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
    elements.coverage.textContent = snapshot ? emptyMessage(snapshot) : '조회 후 상세 정보를 표시합니다.';
    for (const credit of snapshot?.credits ?? []) {
      const article = node('article', undefined, 'credit');
      const header = node('div', undefined, 'credit-header');
      const title = node('div');
      title.append(node('span', `리셋권 ${String(credit.number).padStart(2, '0')}`, 'credit-number'), node('h3', credit.title));
      const badge = node('span', labels[credit.status] ?? labels.unknown, 'badge');
      badge.dataset.tone = badgeTones[credit.status] ?? 'error';
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', `리셋권 상태: ${labels[credit.status] ?? labels.unknown}`);
      header.append(title, badge);
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
  setText(elements['queried-at'], snapshot ? formatSummaryTime(snapshot.queriedAt) : '확인 전');
  setText(elements['queried-at-full'], snapshot ? formatKst(snapshot.queriedAt) : '확인 전');
  const queryState = state.loading ? snapshot ? '재조회 중 · 마지막 성공 결과' : '최초 조회 중'
    : !snapshot && state.kind === 'error' ? `조회 실패 · ${state.message}`
    : snapshot && (state.usageStale || !state.connected) ? '이전 조회 결과 · 재조회 필요'
    : !snapshot ? '조회 전 · 연결 확인 중' : '마지막 조회 기준';
  setText(elements['query-state'], queryState);
  const queryStateRelevant = !snapshot || state.loading || state.usageStale || !state.connected || state.kind === 'error';
  elements['query-state'].classList.toggle('sr-only', !queryStateRelevant);
  const resetPassed = renderUsage(snapshot);
  renderRecommendation(snapshot, resetPassed);
  calendar.update(snapshot, { loading: state.loading, stale: state.usageStale || !state.connected });
  const nearest = snapshot?.credits.find(c => c.expiryState === 'known');
  setText(elements.nearest, nearest ? formatSummaryTime(nearest.expiresAt) : snapshot ? '확인 가능한 만료 시각이 없습니다.' : '아직 조회하지 않았습니다.');
  setText(elements['nearest-remaining'], nearest ? formatSummaryRemaining(nearest.expiresAt) : '');
  for (const row of elements.credits.querySelectorAll('.remaining')) {
    const credit = snapshot?.credits.find(c => String(c.number) === row.dataset.number);
    if (!credit) continue;
    row.textContent = credit.expiryState === 'none' ? '만료 없음' : credit.expiryState === 'unknown' ? '만료 시각 확인 불가' : remainingTime(credit.expiresAt);
    row.dataset.expired = String(credit.expiryState === 'known' && credit.expiresAt * 1000 <= Date.now());
  }
  const restricted = snapshot?.ordinaryUsageAllowed === false;
  const completeUsage = snapshot?.usageWindows?.length === 2
    && snapshot.usageWindows.every(row => row.state === 'complete');
  const incompleteUsage = Boolean(snapshot && !completeUsage);
  const usageStatusRelevant = Boolean(snapshot && (restricted
    || !state.loading && !state.usageStale && (resetPassed || incompleteUsage)));
  elements['usage-status'].hidden = !usageStatusRelevant;
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
    setText(element.querySelector('.usage-reset'), formatSummaryTime(row?.resetsAt, { nowMs: now }));
    setText(element.querySelector('.usage-reset-full'), formatKst(row?.resetsAt));
    setText(element.querySelector('.usage-remaining-full'), remainingTime(row?.resetsAt, now));
    const hasReset = Number.isSafeInteger(row?.resetsAt);
    const passed = hasReset && row.resetsAt * 1000 <= now;
    if (!state.loading && !state.usageStale) announceStatus(`reset-${kind}`, `${snapshot?.accountScope}:${snapshot?.revision}:${row?.resetsAt}:${passed}`, passed
      ? `${kind === 'five-hour' ? '5시간' : '주간'} 리셋 시각이 지났습니다. 최신 사용량을 재조회해 주세요.` : '');
    resetPassed ||= passed;
    element.querySelector('.usage-remaining').textContent = passed ? '리셋 시각 경과: 새로고침 필요'
      : hasReset ? formatSummaryRemaining(row.resetsAt, { nowMs: now }) : '리셋 시각 확인 불가';
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
  return resetPassed;
}
function renderRecommendation(snapshot, resetPassed) {
  const recommendation = recommendReset(snapshot, { refreshing: state.loading, stale: state.usageStale || !state.connected || state.authState !== 'chatgpt' });
  const display = buildRecommendationDisplay(recommendation, snapshot);
  const passed = display.deadlineAt !== null && display.deadlineAt * 1000 < Date.now();
  const deadlinePrefix = passed ? '권장 마감 경과: ' : '';
  elements.recommendation.dataset.code = recommendation.code;
  elements.recommendation.dataset.tone = display.tone;
  // The temporary "refreshing" title is not a change; emphasize only when the settled recommendation differs.
  const settled = recommendation.code !== 'refreshing';
  setText(elements['recommendation-title'], display.title, { emphasize: settled && display.title !== settledRecommendationTitle });
  if (settled) settledRecommendationTitle = display.title;
  setText(elements['recommendation-reason'], display.summaryReason);
  setText(elements['recommendation-target'], display.deadlineAt === null ? '해당 없음' : deadlinePrefix + formatSummaryTime(display.deadlineAt));
  setText(elements['recommendation-remaining'], display.deadlineAt === null ? '' : formatSummaryRemaining(display.deadlineAt));
  elements['recommendation-target'].parentElement.hidden = display.deadlineAt === null;
  setText(elements['recommendation-scope-note'], display.scopeNote);
  setText(elements['recommendation-detail-reason'], display.detailReason);
  setText(document.getElementById('recommendation-credit'), recommendation.credit ? `리셋권 ${recommendation.credit.number} · ${recommendation.credit.title}` : '해당 없음');
  setText(document.getElementById('recommendation-expiry'), recommendation.credit ? formatKst(recommendation.credit.expiresAt) : '해당 없음');
  setText(document.getElementById('recommendation-credit-remaining'), recommendation.credit ? remainingTime(recommendation.credit.expiresAt) : '');
  document.querySelector('#recommendation-details .reset-details').hidden = !recommendation.credit;
  elements['recommendation-urgency'].hidden = display.tone !== 'deadline';
  elements['recommendation-disclaimer'].textContent = ['free-use', 'prepare', 'deadline', 'use-now'].includes(recommendation.code)
    ? '만료 기한 기준 권고입니다. 실제 사용 전에 최신 상태를 확인하세요.' : '최신 상태를 확인한 뒤 사용 시점을 다시 안내합니다.';
  announceStatus('recommendation', `${snapshot?.accountScope}:${recommendation.code}`, recommendation.code === 'refresh-needed' && !resetPassed && !state.usageStale
    ? recommendation.title : '', false);
}
async function api(path, { method = 'GET', data } = {}) {
  const response = await fetch(path, {
    // Timeouts nest: server read 15s < this fetch 17s < usage-read-coordinator 18s.
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
    state = { ...state, connected: false, usageStale: Boolean(state.snapshot) }; usageAlerts?.pause(); render();
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
    const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
    reminders = createReminderController({
      storage,
      locks: globalThis.navigator?.locks,
      Notification: globalThis.Notification,
      crypto: globalThis.crypto,
      refresh: refreshSnapshot,
      onError: () => { reminderError = '알림을 확인하지 못했습니다. 브라우저 저장소와 설정을 확인해 주세요.'; render(); },
    });
    usageAlerts = createUsageAlertController({
      storage, locks: globalThis.navigator?.locks, Notification: globalThis.Notification, crypto: globalThis.crypto,
      refresh: refreshSnapshot, onError: () => { usageAlertError = '알림을 확인하지 못했습니다. 브라우저 저장소와 설정을 확인해 주세요.'; render(); },
    });
    await refreshSnapshot();
    reminders.restore();
    usageAlerts.restore();
    render();
    setInterval(pollStatus, 5000);
  } catch {
    readCoordinator?.close();
    dispatch({ type: 'failure', error: { code: 'SESSION', message: '앱에서 열린 브라우저로 접속해 주세요. 터미널에서 앱을 종료한 뒤 npm start로 다시 실행할 수 있습니다.', clearPrevious: true } });
  }
}
elements.refresh.addEventListener('click', () => refreshSnapshot());
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
  if (!event.persisted) readCoordinator?.close();
});
addEventListener('pageshow', event => {
  if (!event.persisted) return;
  pageSuspended = false;
  const reload = () => { if (!pageSuspended) void refreshSnapshot(); };
  if (activeRefresh) void activeRefresh.then(reload, reload);
  else reload();
});
setInterval(tick, 1000);
start();
