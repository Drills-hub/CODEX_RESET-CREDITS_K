import { formatKst, remainingTime, emptyMessage } from './time.mjs';
import { initialState, updateState } from './state.mjs';
import { createReminderController } from './notifications.mjs';

const elements = Object.fromEntries(['connection', 'refresh', 'notice', 'count', 'nearest', 'nearest-remaining', 'coverage', 'credits', 'queried-at', 'notifications-toggle', 'notifications-status'].map(id => [id, document.getElementById(id)]));
let state = initialState();
let renderedSnapshot;
let sessionReady = false;
let reminders;
let activeRefresh;
const labels = { available: '사용 가능', redeeming: '사용 처리 중', redeemed: '사용 완료', unknown: '상태 확인 불가' };

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function dispatch(event) {
  const previousSnapshot = state.snapshot;
  state = updateState(state, event);
  if (reminders) {
    if (event.type === 'success' && state.snapshot === event.snapshot) reminders.update(event.snapshot);
    else if (event.type === 'failure') {
      if (state.snapshot) reminders.pause();
      else reminders.update(undefined);
    }
    else if (event.type === 'status' && previousSnapshot && !state.snapshot) reminders.update(undefined);
  }
  render();
}
function render() {
  const ready = state.connected && state.authState === 'chatgpt';
  elements.connection.textContent = ready ? 'Codex 연결됨' : state.authState === 'signed-out' ? '로그인 필요' : state.authState === 'unsupported' ? '인증 방식 확인 필요' : state.connected ? '계정 확인 필요' : '연결 확인 필요';
  elements.connection.dataset.state = ready ? 'ready' : 'waiting';
  elements.refresh.disabled = state.loading || !sessionReady;
  elements.refresh.textContent = state.loading ? '조회 중…' : '새로고침 ↻';
  document.body.dataset.loading = String(state.loading);
  elements.notice.textContent = state.message;
  elements.notice.dataset.kind = state.kind;
  if (reminders) {
    elements['notifications-toggle'].disabled = !sessionReady || !reminders.available;
    elements['notifications-toggle'].textContent = reminders.enabled ? '알림 끄기' : '알림 켜기';
    elements['notifications-status'].textContent = reminders.enabled
      ? '알림이 켜졌습니다. 이 브라우저 탭이 열려 있을 때만 확인합니다.'
      : reminders.reason || '브라우저 탭이 열려 있을 때만 24시간 전·1시간 전에 알려드립니다.';
  }
  elements.credits.setAttribute('aria-busy', String(state.loading));
  const snapshot = state.snapshot;
  if (renderedSnapshot !== snapshot) {
    renderedSnapshot = snapshot;
    elements.credits.replaceChildren();
    elements.count.textContent = snapshot?.availableCount ?? '—';
    elements['queried-at'].textContent = snapshot ? formatKst(snapshot.queriedAt) : '—';
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
}
function tick() {
  const snapshot = state.snapshot;
  const nearest = snapshot?.credits.find(c => c.expiryState === 'known');
  elements['nearest-remaining'].textContent = nearest ? remainingTime(nearest.expiresAt) : '';
  for (const row of elements.credits.querySelectorAll('.remaining')) {
    const credit = snapshot?.credits.find(c => String(c.number) === row.dataset.number);
    if (!credit) continue;
    row.textContent = credit.expiryState === 'none' ? '만료 없음' : credit.expiryState === 'unknown' ? '만료 시각 확인 불가' : remainingTime(credit.expiresAt);
    row.dataset.expired = String(credit.expiryState === 'known' && credit.expiresAt * 1000 <= Date.now());
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
  if (!sessionReady) return null;
  if (activeRefresh) return activeRefresh;
  const run = (async () => {
    dispatch({ type: 'loading' });
    try {
      const snapshot = await api('/api/reset-credits/read', { method: 'POST' });
      dispatch({ type: 'success', snapshot });
      return snapshot;
    }
    catch (error) {
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
  if (!sessionReady || state.loading) return;
  try { dispatch({ type: 'status', status: await api('/api/status') }); }
  catch { state = { ...state, connected: false }; render(); }
}
async function start() {
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  try {
    if (token) await api('/api/session', { method: 'POST', data: { token } });
    else await api('/api/status');
    sessionReady = true;
    reminders = createReminderController({
      storage: (() => { try { return globalThis.localStorage; } catch { return null; } })(),
      locks: globalThis.navigator?.locks,
      Notification: globalThis.Notification,
      crypto: globalThis.crypto,
      refresh: refreshSnapshot,
    });
    await refresh();
    reminders.restore();
    render();
    setInterval(pollStatus, 5000);
  } catch {
    dispatch({ type: 'failure', error: { code: 'SESSION', message: '앱에서 열린 브라우저로 접속해 주세요. 터미널에서 앱을 종료한 뒤 npm start로 다시 실행할 수 있습니다.', clearPrevious: true } });
  }
}
elements.refresh.addEventListener('click', refresh);
elements['notifications-toggle'].addEventListener('click', async () => {
  if (reminders?.enabled) reminders.disable();
  else if (reminders) await reminders.requestEnable();
  render();
});
addEventListener('storage', event => {
  if (event.key === null || event.key === 'reset-check.reminders.enabled.v1') {
    reminders?.restore();
    render();
  }
});
setInterval(tick, 1000);
start();
