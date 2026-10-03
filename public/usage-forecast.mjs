const kinds = ['five-hour', 'weekly'];
const interval = 5 * 60 * 1000;
const historySeconds = 30 * 60;

function valid(row, kind) {
  return row?.kind === kind && row.state === 'complete' && row.windowDurationMins === (kind === 'five-hour' ? 300 : 10080)
    && Number.isInteger(row.remainingPercent) && row.remainingPercent >= 0 && row.remainingPercent <= 100
    && Number.isSafeInteger(row.resetsAt) && row.resetsAt >= 0;
}

export function createUsageHistory({ now = Date.now } = {}) {
  const entries = new Map(); let scope; let revision; let stale = false;
  function clear() { entries.clear(); scope = undefined; revision = undefined; stale = false; }
  function update(snapshot) {
    const at = snapshot?.queriedAt;
    if (!snapshot?.accountScope || !Number.isSafeInteger(at) || at < 0 || at * 1000 > now()) { clear(); return; }
    if (scope !== snapshot.accountScope || revision !== snapshot.revision) entries.clear();
    scope = snapshot.accountScope; revision = snapshot.revision; stale = false;
    for (const kind of kinds) {
      const row = snapshot.usageWindows?.find(row => row.kind === kind);
      if (!valid(row, kind) || row.resetsAt <= at) { entries.delete(kind); continue; }
      let entry = entries.get(kind);
      const last = entry?.samples.at(-1);
      if (!entry || entry.resetsAt !== row.resetsAt || (last && (at < last.at || row.remainingPercent > last.remainingPercent))) {
        entry = { resetsAt: row.resetsAt, samples: [] }; entries.set(kind, entry);
      }
      entry.samples = entry.samples.filter(sample => sample.at >= at - historySeconds);
      const sample = { at, remainingPercent: row.remainingPercent };
      if (entry.samples.at(-1)?.at === at) entry.samples[entry.samples.length - 1] = sample;
      else entry.samples.push(sample);
    }
  }
  function read() {
    const seconds = now() / 1000;
    return kinds.map(kind => {
      const entry = entries.get(kind);
      const base = { kind, state: 'unavailable', samples: 0, ratePerHour: null, exhaustsAt: null, resetsAt: entry?.resetsAt ?? null };
      if (!entry) return base;
      entry.samples = entry.samples.filter(sample => sample.at >= seconds - historySeconds && sample.at <= seconds);
      base.samples = entry.samples.length;
      if (stale) return { ...base, state: 'stale' };
      if (entry.resetsAt <= seconds) { entry.samples = []; return { ...base, samples: 0, state: 'reset-passed' }; }
      const last = entry.samples.at(-1);
      if (last?.remainingPercent === 0) return { ...base, state: 'exhausted' };
      if (entry.samples.length < 3) return { ...base, state: 'collecting' };
      const first = entry.samples[0];
      const decrease = first.remainingPercent - last.remainingPercent;
      if (decrease <= 0) return { ...base, state: 'no-decrease' };
      const ratePerHour = decrease * 3600 / (last.at - first.at);
      const exhaustsAt = Math.ceil(last.at + last.remainingPercent * 3600 / ratePerHour);
      if (exhaustsAt <= seconds) return { ...base, state: 'estimate-passed', exhaustsAt };
      return { ...base, ratePerHour, state: exhaustsAt >= entry.resetsAt ? 'reset-first' : 'forecast', exhaustsAt: exhaustsAt >= entry.resetsAt ? null : exhaustsAt };
    });
  }
  return { update, read, clear, pause() { stale = true; } };
}

export function createUsageForecastController({ now = Date.now, refresh, isVisible = () => !globalThis.document?.hidden,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, onChange = () => {} } = {}) {
  const history = createUsageHistory({ now });
  let enabled = false; let latest; let timer; let lifecycle = 0; let generation = 0; let polling = false; let latestStale = false;
  function changed() { try { onChange(); } catch {} }
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; generation++; }
  function plan() {
    clearTimer();
    if (!enabled || !isVisible() || polling) return;
    const expectedLifecycle = lifecycle;
    const expectedGeneration = generation;
    timer = schedule(async () => {
      if (!enabled || !isVisible() || expectedLifecycle !== lifecycle || expectedGeneration !== generation) return;
      timer = undefined;
      polling = true;
      try {
        const fresh = await refresh?.();
        if (!enabled || expectedLifecycle !== lifecycle) return;
        if (fresh) { latest = fresh; latestStale = false; history.update(fresh); }
        else { latestStale = true; history.pause(); }
      } catch { if (enabled && expectedLifecycle === lifecycle) { latestStale = true; history.pause(); } }
      finally { polling = false; changed(); plan(); }
    }, interval);
  }
  return {
    get enabled() { return enabled; },
    enable() { if (enabled) return; enabled = true; lifecycle++; history.clear(); if (latest) history.update(latest); if (latestStale) history.pause(); plan(); changed(); },
    disable() { enabled = false; lifecycle++; clearTimer(); history.clear(); changed(); },
    update(value) {
      if (!value && !latest) return;
      if (latest && (!value || latest.accountScope !== value.accountScope || latest.revision !== value.revision)) lifecycle++;
      latest = value; latestStale = false;
      if (enabled) { if (value) history.update(value); else history.clear(); plan(); changed(); }
    },
    pause() { latestStale = true; history.pause(); changed(); },
    read: history.read,
    visibilityChanged() { plan(); changed(); },
  };
}
