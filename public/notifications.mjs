const preferenceKey = 'reset-check.reminders.enabled.v1';
const ledgerKey = 'reset-check.reminders.sent.v1';
const scopeKey = 'reset-check.reminders.account-scope.v1';
const lockName = 'reset-check.reminders.delivery.v1';
const maxTimerDelay = 2_147_483_647;
const milestones = [['24h', 24 * 60 * 60 * 1000], ['1h', 60 * 60 * 1000]];

export function createReminderController({ storage, locks, Notification, crypto = globalThis.crypto, now = Date.now, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, refresh, notify, onError = () => {} } = {}) {
  let enabled = false;
  let snapshot;
  let revision;
  let timer;
  let timerGeneration = 0;
  let lifecycle = 0;
  let snapshotVersion = 0;

  const available = Boolean(storage && locks?.request && crypto?.subtle && (Notification || notify));
  function report(error) { try { onError(error); } catch {} }
  function cancelTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    timerGeneration++;
  }
  function invalidate() {
    lifecycle++;
    cancelTimer();
  }
  function stillEnabled() {
    if (!enabled) return false;
    try {
      if (storage.getItem(preferenceKey) === 'true') return true;
    } catch (error) { report(error); }
    enabled = false;
    invalidate();
    return false;
  }
  function readLedger() {
    let raw;
    try { raw = storage.getItem(ledgerKey); }
    catch (error) { report(error); return null; }
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(row => row && typeof row.fingerprint === 'string' && ['24h', '1h'].includes(row.milestone) && Number.isFinite(row.sentAt))
        : [];
    } catch { return []; }
  }
  function persistEnabled(value) {
    try { storage.setItem(preferenceKey, value ? 'true' : 'false'); return true; }
    catch (error) { report(error); return false; }
  }
  function removeLedger() {
    try { storage.removeItem(ledgerKey); return true; }
    catch (error) { report(error); return false; }
  }
  function readScope() {
    try { return storage.getItem(scopeKey); }
    catch (error) { report(error); return null; }
  }
  function persistScope(scope) {
    try { storage.setItem(scopeKey, scope); return true; }
    catch (error) { report(error); return false; }
  }
  function persistLedger(ledger) {
    try { storage.setItem(ledgerKey, JSON.stringify(ledger)); return true; }
    catch (error) { report(error); return false; }
  }
  async function fingerprint(credit) {
    const source = JSON.stringify([credit.reminderKey, credit.grantedAt, credit.expiresAt]);
    if (crypto.digest) return crypto.digest(source);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function eligible(credit, at) {
    return typeof credit?.reminderKey === 'string' && credit.reminderKey.length > 0 && credit.status === 'available' && credit.expiryState === 'known' && Number.isSafeInteger(credit.expiresAt) && credit.expiresAt * 1000 > at;
  }
  async function candidates(at, expectedLifecycle) {
    const result = [];
    for (const credit of snapshot?.credits ?? []) {
      if (expectedLifecycle !== lifecycle) return result;
      if (!eligible(credit, at)) continue;
      const hash = await fingerprint(credit);
      if (expectedLifecycle !== lifecycle) return result;
      for (const [milestone, delta] of milestones) {
        const dueAt = credit.expiresAt * 1000 - delta;
        if (dueAt > at) result.push({ credit, fingerprint: hash, milestone, dueAt });
      }
    }
    return result;
  }
  function makeNotification({ credit, milestone, fingerprint }) {
    const ordinal = Number.isSafeInteger(credit.number) && credit.number > 0 ? credit.number : 1;
    const message = milestone === '24h' ? '만료까지 24시간 남았습니다.' : '만료까지 1시간 남았습니다.';
    if (notify) return notify({ title: `리셋권 ${ordinal}번`, body: message });
    return new Notification(`리셋권 ${ordinal}번`, { body: message, tag: `reset-credit-${fingerprint}-${milestone}` });
  }
  async function plan() {
    try {
      cancelTimer();
      const expectedLifecycle = lifecycle;
      const scheduledGeneration = timerGeneration;
      if (!stillEnabled() || !snapshot || Notification?.permission !== 'granted') return;
      const all = await candidates(now(), expectedLifecycle);
      if (expectedLifecycle !== lifecycle || scheduledGeneration !== timerGeneration || !stillEnabled() || Notification?.permission !== 'granted') return;
      const nextDueAt = all.reduce((soonest, item) => Math.min(soonest, item.dueAt), Infinity);
      if (!Number.isFinite(nextDueAt)) return;
      const next = all.filter(item => item.dueAt === nextDueAt);
      const delay = Math.min(maxTimerDelay, Math.max(0, nextDueAt - now()));
      timer = schedule(() => {
        if (stillEnabled() && expectedLifecycle === lifecycle && scheduledGeneration === timerGeneration) return deliver(next, expectedLifecycle);
      }, delay);
    } catch (error) { report(error); }
  }
  async function deliver(targets, expectedLifecycle) {
    cancelTimer();
    if (!stillEnabled() || expectedLifecycle !== lifecycle || Notification?.permission !== 'granted') return;
    if (targets[0]?.dueAt > now()) {
      if (expectedLifecycle === lifecycle && enabled) await plan();
      return;
    }
    try {
      await locks.request(lockName, { mode: 'exclusive' }, async () => {
        if (!stillEnabled() || expectedLifecycle !== lifecycle || Notification?.permission !== 'granted') return;
        const existing = readLedger();
        if (!existing || !enabled || expectedLifecycle !== lifecycle) return;
        targets = targets.filter(target => !existing.some(row => row.fingerprint === target.fingerprint && row.milestone === target.milestone));
        if (!targets.length) return;
        const before = snapshot;
        const fresh = await refresh?.(before);
        if (!fresh || !stillEnabled() || expectedLifecycle !== lifecycle || Notification?.permission !== 'granted') return;
        if (revision !== before?.revision || fresh.revision !== before?.revision || fresh.accountScope !== before?.accountScope) return;
        const validatedVersion = snapshotVersion;
        const freshRows = [];
        for (const credit of fresh.credits ?? []) {
          if (!eligible(credit, now())) continue;
          freshRows.push({ credit, fingerprint: await fingerprint(credit) });
          if (expectedLifecycle !== lifecycle || validatedVersion !== snapshotVersion) return;
        }
        const due = [];
        for (const target of targets) {
          const match = freshRows.find(row => row.fingerprint === target.fingerprint);
          const delta = milestones.find(([key]) => key === target.milestone)?.[1];
          if (!match || delta === undefined || match.credit.expiresAt * 1000 - delta > now()) continue;
          if (!existing.some(row => row.fingerprint === match.fingerprint && row.milestone === target.milestone)) {
            due.push({ ...target, credit: match.credit, fingerprint: match.fingerprint });
          }
        }
        for (const item of due) {
          if (!stillEnabled() || expectedLifecycle !== lifecycle || validatedVersion !== snapshotVersion || Notification?.permission !== 'granted') return;
          const ledger = readLedger();
          if (!ledger || ledger.some(row => row.fingerprint === item.fingerprint && row.milestone === item.milestone)) continue;
          const previousLedger = ledger.slice();
          ledger.push({ fingerprint: item.fingerprint, milestone: item.milestone, sentAt: now() });
          if (!persistLedger(ledger)) return;
          if (!stillEnabled() || expectedLifecycle !== lifecycle || Notification?.permission !== 'granted') return;
          try { makeNotification(item); }
          catch (error) {
            persistLedger(previousLedger);
            report(error);
            return;
          }
        }
        if (expectedLifecycle === lifecycle) snapshot = fresh;
      });
    } catch (error) { report(error); }
    if (expectedLifecycle === lifecycle && enabled) await plan();
  }
  return {
    get available() { return available; },
    get enabled() { return enabled; },
    get reason() {
      if (!storage) return '이 브라우저는 로컬 저장소를 사용할 수 없어 알림을 켤 수 없습니다.';
      if (!locks?.request) return '이 브라우저는 탭 간 잠금 기능을 지원하지 않아 알림을 켤 수 없습니다.';
      if (!Notification) return '이 브라우저는 알림 기능을 지원하지 않습니다.';
      if (Notification.permission === 'denied') return '브라우저 알림 권한이 차단되어 있습니다. 사이트 설정에서 허용해 주세요.';
      return '';
    },
    async requestEnable() {
      if (!available || Notification?.permission === 'denied') return false;
      const expectedLifecycle = lifecycle;
      try {
        const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission !== 'granted' || expectedLifecycle !== lifecycle || !persistEnabled(true)) return false;
        enabled = true;
        await plan();
        return true;
      } catch (error) { report(error); return false; }
    },
    enable() {
      if (!available || Notification?.permission !== 'granted' || !persistEnabled(true)) return false;
      enabled = true;
      void plan();
      return true;
    },
    disable() {
      enabled = false;
      invalidate();
      persistEnabled(false);
    },
    restore() {
      if (!available) return false;
      let stored;
      try { stored = storage.getItem(preferenceKey); }
      catch (error) { report(error); return false; }
      enabled = stored === 'true' && Notification?.permission === 'granted';
      if (enabled) void plan();
      else invalidate();
      return enabled;
    },
    update(value) {
      snapshotVersion++;
      const changed = revision !== undefined && (!value || value.revision !== revision);
      const nextScope = typeof value?.accountScope === 'string' && value.accountScope ? value.accountScope : undefined;
      const previousScope = nextScope ? readScope() : undefined;
      const scopeChanged = Boolean(nextScope && previousScope && nextScope !== previousScope);
      if (changed || !value || scopeChanged) {
        invalidate();
        if ((changed || scopeChanged) && !removeLedger()) enabled = false;
      }
      revision = value?.revision;
      snapshot = value;
      if (nextScope && previousScope !== nextScope && !persistScope(nextScope)) enabled = false;
      if (enabled) void plan();
      else if (!value) cancelTimer();
    },
    cancel() {
      invalidate();
      snapshot = undefined;
    },
    pause() {
      cancelTimer();
      if (enabled && snapshot) void plan();
    },
  };
}
