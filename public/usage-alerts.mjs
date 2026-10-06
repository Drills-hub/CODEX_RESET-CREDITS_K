import { sha256Hex } from './notifications.mjs';

const preferenceKey = 'reset-check.usage-alerts.enabled.v1';
const ledgerKey = 'reset-check.usage-alerts.sent.v1';
const scopeKey = 'reset-check.usage-alerts.account-scope.v1';
const retryKey = 'reset-check.usage-alerts.retry.v1';
const lockName = 'reset-check.usage-alerts.delivery.v1';
const minute = 60000;
const maxDelay = 2_147_483_647;

function windows(value) {
  return (value?.usageWindows ?? []).filter(row => ['five-hour', 'weekly'].includes(row?.kind) && row.state === 'complete'
    && Number.isInteger(row.remainingPercent) && row.remainingPercent >= 0 && row.remainingPercent <= 100
    && Number.isSafeInteger(row.resetsAt) && row.resetsAt >= 0);
}

export function createUsageAlertController({ storage, locks, Notification = globalThis.Notification, crypto = globalThis.crypto,
  now = Date.now, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout,
  refresh, onError = () => {} } = {}) {
  let enabled = false; let snapshot; let timer; let lifecycle = 0; let generation = 0; let version = 0;
  let paused = false; let delivering = false;
  const transitions = new Map(); const retries = new Map();
  const available = Boolean(storage && locks?.request && crypto?.subtle && Notification);
  const report = error => { try { onError(error); } catch {} };
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; generation++; }
  function invalidate() { lifecycle++; clearTimer(); }
  function read(key) { try { return storage.getItem(key); } catch (error) { report(error); return undefined; } }
  function write(key, value) { try { storage.setItem(key, value); return true; } catch (error) { report(error); return false; } }
  function clearLedger() { try { storage.removeItem(ledgerKey); storage.removeItem(retryKey); return true; } catch (error) { report(error); return false; } }
  function sharedRetries() {
    const raw = read(retryKey);
    if (raw === undefined) return null;
    try { return raw === null ? [] : JSON.parse(raw).filter(row => /^[a-f0-9]{64}$/.test(row?.fingerprint) && Number.isFinite(row.retryAt) && row.retryAt > now()); }
    catch { return []; }
  }
  function active() {
    if (!enabled || paused || Notification?.permission !== 'granted') return false;
    if (read(preferenceKey) !== 'true') { enabled = false; invalidate(); return false; }
    return Boolean(snapshot?.accountScope && read(scopeKey) === snapshot.accountScope);
  }
  function ledger() {
    const raw = read(ledgerKey);
    if (raw === undefined) return null;
    try { return raw === null ? [] : JSON.parse(raw).filter(row => /^[a-f0-9]{64}$/.test(row?.fingerprint)
      && ['soon', 'low', 'reset'].includes(row.milestone) && Number.isFinite(row.sentAt)); }
    catch { return []; }
  }
  function fingerprint(event) {
    return sha256Hex(crypto, JSON.stringify([snapshot.accountScope, event.kind, event.resetsAt]));
  }
  function update(value) {
    const changed = snapshot && (!value || snapshot.revision !== value.revision || snapshot.accountScope !== value.accountScope);
    const nextScope = typeof value?.accountScope === 'string' && value.accountScope ? value.accountScope : null;
    const storedScope = nextScope ? read(scopeKey) : null;
    const scopeChanged = Boolean(nextScope && storedScope && storedScope !== nextScope);
    if (changed || !value || scopeChanged) {
      invalidate(); transitions.clear(); retries.clear();
      if (scopeChanged && !clearLedger()) enabled = false;
    }
    if (!changed && snapshot && value && nextScope) {
      for (const previous of windows(snapshot)) {
        const current = windows(value).find(row => row.kind === previous.kind);
        if (current && previous.resetsAt * 1000 <= now() && current.resetsAt > previous.resetsAt && current.resetsAt * 1000 > now()) {
          transitions.set(previous.kind, { kind: previous.kind, resetsAt: previous.resetsAt, milestone: 'reset', dueAt: now() });
        }
      }
    }
    snapshot = value; version++; paused = false;
    if (nextScope && storedScope !== nextScope && !write(scopeKey, nextScope)) enabled = false;
    if (!value) clearTimer();
    else if (enabled && !delivering) void plan();
  }
  async function candidates() {
    const events = [];
    const at = now();
    for (const row of windows(snapshot)) {
      const reset = row.resetsAt * 1000;
      if (reset > at) {
        events.push({ ...row, milestone: 'soon', dueAt: Math.max(at, reset - 30 * minute) });
        if (row.remainingPercent <= 20) events.push({ ...row, milestone: 'low', dueAt: at });
      }
      events.push({ ...row, milestone: 'reset', dueAt: reset > at ? reset : Math.max(at, retries.get(row.kind) ?? at) });
    }
    for (const event of transitions.values()) {
      if (windows(snapshot).some(row => row.kind === event.kind)) events.push({ ...event, dueAt: Math.max(event.dueAt, retries.get(event.kind) ?? 0) });
    }
    const existing = ledger();
    const pending = sharedRetries();
    if (!existing || !pending) return [];
    const results = [];
    for (const event of events) {
      const hash = await fingerprint(event);
      const retryAt = event.milestone === 'reset' ? pending.find(row => row.fingerprint === hash)?.retryAt ?? 0 : 0;
      if (!existing.some(row => row.fingerprint === hash && row.milestone === event.milestone)) results.push({ ...event, dueAt: Math.max(event.dueAt, retryAt), fingerprint: hash });
    }
    return results;
  }
  async function plan() {
    if (delivering) return;
    clearTimer();
    const expectedLifecycle = lifecycle; const expectedGeneration = generation;
    if (!active() || !snapshot) return;
    try {
      const all = await candidates();
      if (!active() || expectedLifecycle !== lifecycle || expectedGeneration !== generation) return;
      const dueAt = Math.min(...all.map(row => row.dueAt));
      if (!Number.isFinite(dueAt)) return;
      const targets = all.filter(row => row.dueAt === dueAt);
      timer = schedule(() => deliver(targets, expectedLifecycle, expectedGeneration), Math.min(maxDelay, Math.max(0, dueAt - now())));
    } catch (error) { report(error); }
  }
  async function deliver(targets, expectedLifecycle, expectedGeneration) {
    if (!active() || expectedLifecycle !== lifecycle || expectedGeneration !== generation) return;
    clearTimer();
    if (targets[0].dueAt > now()) { await plan(); return; }
    delivering = true;
    try {
      await locks.request(lockName, { mode: 'exclusive' }, async () => {
        if (!active() || expectedLifecycle !== lifecycle) return;
        const existing = ledger();
        const pending = sharedRetries();
        if (!existing || !pending) return;
        targets = targets.filter(item => {
          if (existing.some(row => row.fingerprint === item.fingerprint && row.milestone === item.milestone)) return false;
          const retryAt = item.milestone === 'reset' ? pending.find(row => row.fingerprint === item.fingerprint)?.retryAt : null;
          if (retryAt) { retries.set(item.kind, retryAt); return false; }
          return true;
        });
        if (!targets.length) return;
        const before = snapshot;
        const fresh = await refresh?.();
        if (!fresh) { paused = true; invalidate(); return; }
        if (!active() || expectedLifecycle !== lifecycle || fresh.accountScope !== before.accountScope || fresh.revision !== before.revision) return;
        update(fresh);
        const validatedVersion = version;
        for (const event of targets) {
          const row = windows(fresh).find(row => row.kind === event.kind);
          const same = row?.resetsAt === event.resetsAt;
          const at = now();
          const valid = event.milestone === 'reset'
            ? row && event.resetsAt * 1000 <= at && row.resetsAt > event.resetsAt && row.resetsAt * 1000 > at
            : same && row.resetsAt * 1000 > at && (event.milestone === 'low' ? row.remainingPercent <= 20 : row.resetsAt * 1000 - at <= 30 * minute);
          if (!valid) {
            if (event.milestone === 'reset') {
              const retryAt = at + minute;
              retries.set(event.kind, retryAt);
              const shared = sharedRetries();
              if (!shared || !write(retryKey, JSON.stringify([...shared.filter(row => row.fingerprint !== event.fingerprint).slice(-49), { fingerprint: event.fingerprint, retryAt }]))) { paused = true; return; }
            }
            continue;
          }
          if (!active() || expectedLifecycle !== lifecycle || validatedVersion !== version) return;
          const currentLedger = ledger();
          if (!currentLedger || currentLedger.some(item => item.fingerprint === event.fingerprint && item.milestone === event.milestone)) continue;
          const nextLedger = [...currentLedger.slice(-499), { fingerprint: event.fingerprint, milestone: event.milestone, sentAt: at }];
          if (!write(ledgerKey, JSON.stringify(nextLedger))) { paused = true; return; }
          const label = event.kind === 'five-hour' ? '5시간' : '주간';
          const body = event.milestone === 'soon' ? '리셋까지 30분 이내입니다. 최신 잔여량을 확인하세요.'
            : event.milestone === 'low' ? `마지막 조회 기준 잔여량이 ${row.remainingPercent}%입니다.`
            : `리셋 시각 갱신이 확인됐습니다. 마지막 조회 기준 잔여량은 ${row.remainingPercent}%입니다.`;
          if (!active() || expectedLifecycle !== lifecycle || validatedVersion !== version) return;
          try { new Notification(`${label} 사용 한도`, { body, tag: `usage-${event.fingerprint}-${event.milestone}` }); }
          catch (error) { write(ledgerKey, JSON.stringify(currentLedger)); paused = true; report(error); return; }
        }
      });
    } catch (error) { paused = true; invalidate(); report(error); }
    finally { delivering = false; await plan(); }
  }
  return {
    get available() { return available; }, get enabled() { return enabled; },
    get reason() { return !available ? '이 브라우저의 저장소·알림·탭 간 잠금 기능을 사용할 수 없습니다.'
      : Notification.permission === 'denied' ? '브라우저 알림 권한이 차단되어 있습니다. 사이트 설정에서 허용해 주세요.'
      : paused ? '알림 확인을 중지했습니다. 새로고침에 성공하면 다시 확인합니다.' : ''; },
    async requestEnable() {
      if (!available || Notification.permission === 'denied') return false;
      const expectedLifecycle = lifecycle;
      try {
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission !== 'granted' || lifecycle !== expectedLifecycle || !write(preferenceKey, 'true')) return false;
        enabled = true; paused = false; await plan(); return true;
      } catch (error) { report(error); return false; }
    },
    restore() { if (!available) return false; enabled = read(preferenceKey) === 'true' && Notification.permission === 'granted'; if (enabled) void plan(); else invalidate(); return enabled; },
    disable() { enabled = false; paused = false; invalidate(); write(preferenceKey, 'false'); },
    update,
    pause() { paused = true; invalidate(); },
  };
}
