import { buildUsagePlan } from './usage-timing.mjs';

const HOUR = 3600, EPS = 1e-6;
const timestamp = n => Number.isSafeInteger(n) && n >= 0;
const percent = n => Number.isFinite(n) && n >= 0 && n <= 100;
const positive = n => Number.isFinite(n) && n > 0;
const clamp = n => Math.max(0, Math.min(100, n));

export function parseKstInput(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(n => Number(n ?? 0));
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const seconds = date.getTime() / 1000 - 9 * HOUR;
  return timestamp(seconds) ? seconds : null;
}

export function normalizeWorkSlots(slots, { now = 0, until = Infinity } = {}) {
  if (!Array.isArray(slots) || slots.length > 32 || !timestamp(now)
    || !(until === Infinity || timestamp(until)) || until < now) return [];
  const rows = slots.filter(s => timestamp(s?.startAt) && timestamp(s?.endAt) && s.startAt < s.endAt)
    .map(s => ({ startAt: Math.max(now, s.startAt), endAt: Math.min(until, s.endAt) }))
    .filter(s => s.startAt < s.endAt).sort((a, b) => a.startAt - b.startAt);
  const merged = [];
  for (const row of rows) {
    const last = merged.at(-1);
    if (last && row.startAt <= last.endAt) last.endAt = Math.max(last.endAt, row.endAt);
    else merged.push(row);
  }
  return merged;
}

export function estimateConsumption(samples, { now } = {}) {
  const result = { state: 'unavailable', weeklyPerHour: null, fiveHourPerHour: null, samples: 0 };
  if (!Array.isArray(samples) || !timestamp(now)) return result;
  let suffix = [];
  for (const row of samples) {
    if (!timestamp(row?.at) || row.at > now || row.at < now - 1800
      || !percent(row.weeklyRemaining) || !percent(row.fiveRemaining)
      || !timestamp(row.weeklyResetsAt) || row.weeklyResetsAt <= now
      || !timestamp(row.fiveResetsAt) || row.fiveResetsAt <= row.at
      || typeof row.accountScope !== 'string' || !row.accountScope
      || !['string', 'number'].includes(typeof row.revision) || (typeof row.revision === 'number' && !Number.isFinite(row.revision))
      || !['string', 'number'].includes(typeof row.activeSession) || row.activeSession === ''
      || (typeof row.activeSession === 'number' && !Number.isFinite(row.activeSession))) { suffix = []; continue; }
    // Replacing an equal timestamp is not a new observation. Revalidate its predecessor.
    if (suffix.at(-1)?.at === row.at) suffix.pop();
    const last = suffix.at(-1);
    if (last && (row.at < last.at || row.accountScope !== last.accountScope || row.revision !== last.revision
      || row.activeSession !== last.activeSession || row.weeklyResetsAt !== last.weeklyResetsAt
      || row.weeklyRemaining > last.weeklyRemaining)) suffix = [];
    suffix.push(row);
  }
  result.samples = suffix.length;
  if (!suffix.length) return result;
  if (suffix.length < 3) return { ...result, state: 'collecting' };
  const first = suffix[0], last = suffix.at(-1), hours = (last.at - first.at) / HOUR;
  const decrease = first.weeklyRemaining - last.weeklyRemaining;
  if (decrease <= 0) return { ...result, state: 'no-decrease' };
  result.state = 'ready'; result.weeklyPerHour = decrease / hours;
  const validFive = suffix.every((s, i) => s.fiveResetsAt === first.fiveResetsAt && s.fiveResetsAt > now
    && (!i || s.fiveRemaining <= suffix[i - 1].fiveRemaining));
  // Flat integer readings can conceal consumption through rounding: unknown, not sustained zero.
  if (validFive && first.fiveRemaining > last.fiveRemaining) result.fiveHourPerHour = (first.fiveRemaining - last.fiveRemaining) / hours;
  return result;
}

function eligibleCredits(snapshot, now) {
  if (!['complete', 'partial'].includes(snapshot?.detailState) || !Array.isArray(snapshot.credits)) return [];
  const seen = new Set();
  return snapshot.credits.filter(c => c?.status === 'available' && c.expiryState === 'known'
    && timestamp(c.expiresAt) && c.expiresAt > now && timestamp(c.number) && c.number > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.number - b.number)
    .filter(c => { if (seen.has(c.number)) return false; seen.add(c.number); return true; }).slice(0, 2);
}
const inSlots = (at, slots) => slots.some(s => at >= s.startAt && at <= s.endAt);
const deadlineAt = (credit, now) => Math.max(now, credit.expiresAt - HOUR);
const validSlots = slots => Array.isArray(slots) && slots.length <= 32
  && slots.every(s => timestamp(s?.startAt) && timestamp(s?.endAt) && s.startAt < s.endAt);
function windowsAt(snapshot, now) {
  if (!timestamp(now) || !timestamp(snapshot?.queriedAt) || snapshot.queriedAt > now
    || snapshot.ordinaryUsageAllowed === false || !Array.isArray(snapshot.usageWindows)) return null;
  const rows = ['weekly', 'five-hour'].map(kind => snapshot.usageWindows.find(w => w?.kind === kind));
  return ['weekly', 'five-hour'].every(kind => snapshot.usageWindows.filter(w => w?.kind === kind).length === 1)
    && rows.every(w => w?.state === 'complete' && Number.isInteger(w.remainingPercent)
    && percent(w.remainingPercent) && timestamp(w.resetsAt) && w.resetsAt > now) ? rows : null;
}

// Times are seconds; each budget is consumed in its own %p / active-hour units.
export function simulateUsage(snapshot, workSlots, redemptions, {
  now = snapshot?.queriedAt, weeklyPerHour, fiveHourPerHour = null, speedFactor = 1, accessSlots = workSlots,
} = {}) {
  const result = { state: 'incomplete', horizonAt: null, firstUseAt: null, nextUseAt: null,
    workSlots: [], accessSlots: [], segments: [], events: [], discards: [], warnings: [],
    metrics: { totalUsedPercent: null, totalDiscardedPercent: null, firstRemainingPercent: null,
      nextRemainingPercent: null, blockedWorkHours: null, expiredCredits: null } };
  const windows = windowsAt(snapshot, now);
  if (!windows || !positive(weeklyPerHour) || !positive(speedFactor)
    || !(fiveHourPerHour === null || (Number.isFinite(fiveHourPerHour) && fiveHourPerHour >= 0))) return result;
  const weeklyRate = weeklyPerHour * speedFactor;
  const fiveRate = fiveHourPerHour === null ? null : fiveHourPerHour * speedFactor;
  if (!positive(weeklyRate) || !(fiveRate === null || Number.isFinite(fiveRate))
    || !validSlots(workSlots) || !validSlots(accessSlots)
    || !Array.isArray(redemptions) || redemptions.length > 2) return result;
  const [weeklyWindow, fiveWindow] = windows, credits = eligibleCredits(snapshot, now);
  const access = normalizeWorkSlots(accessSlots, { now }), work = normalizeWorkSlots(workSlots, { now });
  const lastWorkEnd = work.at(-1)?.endAt ?? now;
  // All candidates see all entered work, including productive use after the final review.
  const horizon = Math.max(lastWorkEnd, credits.length ? deadlineAt(credits.at(-1), now) : now);
  const chosen = [];
  for (const row of redemptions) {
    const c = credits.find(c => c.number === row?.number);
    if (!c || !timestamp(row.at) || row.at < now || row.at > deadlineAt(c, now)
      || row.at > horizon || !inSlots(row.at, access) || chosen.some(r => r.number === row.number)
      || (chosen.length && row.at <= chosen.at(-1).at)) return result;
    chosen.push({ ...row, credit: c });
  }
  result.state = 'ready'; result.horizonAt = horizon;
  result.workSlots = normalizeWorkSlots(work, { now, until: horizon });
  result.accessSlots = normalizeWorkSlots(access, { now, until: horizon });
  const event = (kind, at, label, creditNumber = null, assumed = false) => ({ kind, at, label, creditNumber, assumed });
  result.events.push(event('now', now, '계산 기준 시각'));
  for (const c of credits) result.events.push(event('credit-expiry', c.expiresAt, `${c.number}번 리셋권 만료 예정`, c.number));
  if (fiveRate === null) result.warnings.push('5시간 작업 소모율을 알 수 없어 병목을 확인할 수 없습니다. 주간 %p를 환산하지 않습니다.');
  result.warnings.push('작업 소모율이 유지된다는 가정이며 실제 사용 허용 여부는 재조회로 확인하세요.');
  if (credits.some(c => c.expiresAt - HOUR <= now)) result.warnings.push('안전 여유가 지났지만 아직 만료되지 않았습니다. 접속 가능하면 즉시 재조회 후 검토하세요.');
  const resets = [event('weekly-reset', weeklyWindow.resetsAt, '주간 100% 자연 리셋 가정 시나리오 · 재조회 필요', null, true),
    event('five-hour-reset', fiveWindow.resetsAt, '5시간 100% 자연 리셋 가정 시나리오 · 재조회 필요', null, true)]
    .filter(e => e.at <= horizon);
  const reviews = chosen.map(r => event('credit-use', r.at, `${r.number}번 리셋권 재조회 후 사용 검토 · 충전 가정`, r.number, true));
  const actions = [...resets, ...reviews].sort((a, b) => a.at - b.at || (a.kind === 'credit-use') - (b.kind === 'credit-use'));
  const bounds = [...new Set([now, horizon, ...result.workSlots.flatMap(s => [s.startAt, s.endAt]), ...actions.map(e => e.at)])].sort((a, b) => a - b);
  let weekly = weeklyWindow.remainingPercent, five = fiveWindow.remainingPercent, kind = 'estimate';
  let used = 0, discarded = 0, blocked = 0, rescued = 0;
  const segment = (fromAt, toAt, fromPercent, toPercent) => {
    if (toAt > fromAt) result.segments.push({ kind, fromAt, toAt, fromPercent, toPercent });
  };
  for (let i = 0; i < bounds.length; i++) {
    const at = bounds[i];
    for (const e of actions.filter(e => e.at === at)) {
      result.events.push(e);
      if (e.kind === 'weekly-reset') {
        result.discards.push({ kind: e.kind, at, creditNumber: null, remainingPercent: weekly });
        discarded += weekly; weekly = 100;
      }
      else if (e.kind === 'five-hour-reset') five = 100;
      else {
        const r = chosen.find(r => r.number === e.creditNumber);
        rescued++;
        if (e.creditNumber === credits[0].number) { result.firstUseAt = at; result.metrics.firstRemainingPercent = weekly; }
        else { result.nextUseAt = at; result.metrics.nextRemainingPercent = weekly; }
        if (r.credit.resetType !== 'codexRateLimits') {
          result.state = 'uncertain';
          result.warnings.push('리셋권 효과 미확인: 첫 불명확한 검토 이후 수치 계산을 중단하며 다음 충전을 가정하지 않습니다.');
          result.metrics.expiredCredits = credits.length - rescued;
          result.events.sort((a, b) => a.at - b.at);
          return result;
        }
        result.discards.push({ kind: e.kind, at, creditNumber: e.creditNumber, remainingPercent: weekly });
        discarded += weekly; weekly = 100;
        if (fiveRate !== null) five = 100;
        result.warnings.push('리셋권 주간 100% 충전 가정 시나리오 · 실제 효과는 재조회가 필요합니다.');
        if (fiveRate !== null) result.warnings.push('리셋권의 5시간 100% 충전도 가정이며 실제 복구를 보장하지 않습니다.');
      }
      kind = 'scenario';
    }
    const end = bounds[i + 1];
    if (end === undefined) break;
    const working = result.workSlots.some(s => at >= s.startAt && end <= s.endAt);
    if (!working) { segment(at, end, weekly, weekly); continue; }
    const hours = (end - at) / HOUR;
    const availableFive = five === 0 ? 0 : fiveRate === null || fiveRate === 0 ? hours : five / fiveRate;
    const productive = Math.min(hours, weekly / weeklyRate, availableFive);
    const before = weekly, consumed = Math.min(weekly, weeklyRate * productive);
    weekly = clamp(weekly - consumed); used += consumed;
    if (fiveRate !== null) five = clamp(five - Math.min(five, fiveRate * productive));
    blocked += hours - productive;
    const split = Math.max(at, Math.min(end, at + productive * HOUR));
    segment(at, split, before, weekly);
    segment(split, end, weekly, weekly);
  }
  Object.assign(result.metrics, { totalUsedPercent: used, totalDiscardedPercent: discarded,
    blockedWorkHours: blocked, expiredCredits: credits.length - rescued });
  result.warnings = [...new Set(result.warnings)];
  result.events.sort((a, b) => a.at - b.at);
  return result;
}

function comparePrimary(a, b) {
  for (const [key, direction] of [['expiredCredits', 1], ['totalUsedPercent', -1], ['totalDiscardedPercent', 1]]) {
    const delta = a.metrics[key] - b.metrics[key];
    if (Math.abs(delta) > EPS) return delta * direction;
  }
  return 0;
}
const reviewAt = r => r.firstUseAt ?? r.nextUseAt ?? null;
const compare = (a, b) => comparePrimary(a, b) || (reviewAt(b) ?? -1) - (reviewAt(a) ?? -1);
export function chooseRedemptionPlan(results) {
  if (!Array.isArray(results)) return null;
  const valid = results.filter(r => r?.state === 'ready' && timestamp(r.horizonAt)
    && (r.firstUseAt === null || timestamp(r.firstUseAt))
    && (r.nextUseAt === undefined || r.nextUseAt === null || timestamp(r.nextUseAt))
    && ['totalUsedPercent', 'totalDiscardedPercent', 'expiredCredits'].every(k => Number.isFinite(r.metrics?.[k]) && r.metrics[k] >= 0));
  const reference = r => r.events?.find(e => e.kind === 'now')?.at ?? null;
  if (!valid.length || valid.some(r => r.horizonAt !== valid[0].horizonAt || reference(r) !== reference(valid[0]))) return null;
  return [...valid].sort(compare)[0];
}

// Bounded sampling never iterates every quarter-hour in a potentially enormous interval.
function candidateTimes(access, now, deadline, limit, depletion = []) {
  const pool = new Set(), endpoints = new Set();
  for (const slot of access) {
    const start = Math.max(now, slot.startAt), end = Math.min(deadline, slot.endAt);
    if (start > end) continue;
    endpoints.add(start); endpoints.add(end); pool.add(start); pool.add(end);
    const gridStart = Math.ceil(start / 900) * 900, count = Math.floor((end - gridStart) / 900) + 1;
    for (let i = 0; i < Math.min(limit, count); i++) {
      const index = count <= limit ? i : Math.round(i * (count - 1) / (limit - 1));
      pool.add(gridStart + index * 900);
    }
  }
  const extra = depletion.map(Math.ceil).filter(t => timestamp(t) && t >= now && t <= deadline && inSlots(t, access));
  extra.forEach(t => pool.add(t));
  const sorted = [...pool].sort((a, b) => a - b);
  if (sorted.length <= limit) return sorted;
  const keep = new Set([sorted[0], sorted.at(-1), ...extra.slice(0, 2)]);
  const fill = rows => {
    const available = rows.filter(t => !keep.has(t)), room = limit - keep.size;
    for (let i = 0; i < Math.min(room, available.length); i++) {
      keep.add(available.length <= room ? available[i] : available[Math.round(i * (available.length - 1) / Math.max(1, room - 1))]);
    }
  };
  fill([...endpoints].sort((a, b) => a - b)); fill(sorted);
  return [...keep].sort((a, b) => a - b);
}
const depletionTimes = simulation => simulation.segments.filter(s => s.fromPercent > 0 && s.toPercent === 0).map(s => s.toAt);

// Observed budgets only: stop at the first natural reset, which requires a
// fresh read. Idle time consumes nothing; no hypothetical refill is applied.
function currentDepletions(snapshot, slots, now, weeklyRate, fiveRate) {
  const windows = snapshot.usageWindows;
  if (windows.some(row => row.remainingPercent === 0)) return [];
  const beforeReset = Math.min(...windows.map(row => row.resetsAt));
  const found = [];
  for (const [kind, rate] of [['weekly', weeklyRate], ['five-hour', fiveRate]]) {
    const row = windows.find(window => window.kind === kind);
    if (!row || !positive(rate) || row.remainingPercent <= 0) continue;
    let needed = row.remainingPercent / rate * HOUR;
    if (!Number.isFinite(needed)) continue;
    for (const slot of slots) {
      const start = Math.max(now, slot.startAt), end = Math.min(beforeReset, slot.endAt);
      if (end <= start) continue;
      if (needed <= end - start) {
        const at = start + needed;
        if (at < beforeReset && Number.isFinite(at)) found.push({ kind, at });
        break;
      }
      needed -= end - start;
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

export function buildWorkSchedulePlan(snapshot, {
  now = snapshot?.queriedAt, stale = false, refreshing = false, workSlots = [], accessSlots = workSlots,
  weeklyPerHour = null, fiveHourPerHour = null, rateSource = 'manual',
} = {}) {
  const plan = buildUsagePlan(snapshot, { now, stale, refreshing, rateSource });
  Object.assign(plan, { ratePerDay: null, requiredRatePerDay: null, exhaustsAt: null,
    firstUseAt: null, nextGapSeconds: null, nextRequiredRatePerDay: null, remainingAtTarget: null,
    nextRemainingPercent: null, events: [], segments: [] });
  const schedule = plan.schedule = {
    recommendedStart: null, recommendedEnd: null, lastSafeAt: null, nextUseAt: null,
    reviewCreditNumber: null, reviewRemainingPercent: null,
    totalUsedPercent: null, totalDiscardedPercent: null, firstRemainingPercent: null,
    expiredCredits: null, blockedWorkHours: null, weeklyPerHour: null, fiveHourPerHour: null,
    rateSource: rateSource === 'manual' ? 'manual' : 'auto', workSlots: [], accessSlots: [],
    scenarios: [], candidates: [], assumptions: [],
    currentDepletionAt: null, currentDepletionKind: null, currentDepletionCandidates: [],
  };
  if (plan.state !== 'ready') return plan;
  // Preserve the established read guards, not the old calendar-rate projection or copy.
  plan.warnings = [];
  const incomplete = reason => { plan.state = plan.code = 'incomplete'; plan.title = '작업 일정 계산을 보류합니다.'; plan.reason = reason; return plan; };
  if (!timestamp(now) || !validSlots(workSlots) || !validSlots(accessSlots)) return incomplete('올바른 초 단위 작업·접속 구간을 32개 이하로 입력하세요.');
  schedule.workSlots = normalizeWorkSlots(workSlots, { now });
  schedule.accessSlots = normalizeWorkSlots(accessSlots, { now });
  if (!schedule.workSlots.length) return incomplete('앞으로 작업할 구간을 입력하세요. 작업 시간만 소모량 계산에 사용합니다.');
  if (!positive(weeklyPerHour) || !(fiveHourPerHour === null || (Number.isFinite(fiveHourPerHour) && fiveHourPerHour >= 0))) {
    return incomplete('주간 소모율을 양수 %p/작업시간으로 입력하거나 같은 작업 세션의 검증된 측정을 기다리세요. 5시간 소모율은 별도 값입니다.');
  }
  schedule.weeklyPerHour = weeklyPerHour; schedule.fiveHourPerHour = fiveHourPerHour;
  schedule.currentDepletionCandidates = currentDepletions(snapshot, schedule.workSlots, now, weeklyPerHour, fiveHourPerHour);
  schedule.currentDepletionAt = schedule.currentDepletionCandidates[0]?.at ?? null;
  schedule.currentDepletionKind = schedule.currentDepletionCandidates[0]?.kind ?? null;
  const credits = eligibleCredits(snapshot, now);
  const toCredit = c => c ? { number: c.number, title: typeof c.title === 'string' ? c.title : '리셋권',
    expiresAt: c.expiresAt, deadlineAt: deadlineAt(c, now), resetType: c.resetType === 'codexRateLimits' ? c.resetType : 'unknown' } : null;
  plan.firstCredit = toCredit(credits[0]); plan.nextCredit = toCredit(credits[1]);
  const first = plan.firstCredit, next = plan.nextCredit;
  plan.targetAt = first?.deadlineAt ?? snapshot.usageWindows.find(w => w.kind === 'weekly').resetsAt;
  if (plan.coverage === 'partial') plan.warnings.push('리셋권 상세가 일부만 조회되어 조회된 항목 중에서만 계획합니다.');
  if (!['complete', 'partial'].includes(plan.coverage)) plan.warnings.push('리셋권 상세 만료 시각 미확인: 개수로 일정을 만들지 않습니다.');
  if (Array.isArray(snapshot.credits) && snapshot.credits.some(c => c?.status === 'available' && c.expiryState !== 'known')) plan.warnings.push('만료 시각 미확인 리셋권은 계획에서 제외했습니다.');
  if (first && next && first.expiresAt === next.expiresAt) plan.warnings.push('두 리셋권의 만료가 같습니다. 같은 시각에 두 번 검토할 수는 없습니다.');
  if (snapshot.ordinaryUsageAllowed !== true) plan.warnings.push('실제 사용이 허용되는 경우에만 활용할 조건부 계획입니다.');
  if (snapshot.usageWindows.some(w => w.remainingPercent === 0)) plan.warnings.push('실제 잔여량 0%는 작업을 막습니다. 복구 가정 시점에 반드시 재조회하세요.');
  schedule.assumptions = ['소모율은 %p/작업시간이며 접속만 가능한 구간에는 소모하지 않습니다.',
    '미래 검토·100% 충전·자연 리셋은 가정이며 실제 사용 권한이나 복구를 보장하지 않습니다.',
    '추천 구간은 평가한 후보 중 목적 점수가 같은 시각 범위입니다. 범위 안 모든 시각의 최적성을 보장하지 않습니다.',
    '느림·기준·빠름은 민감도 시나리오이며 통계적 신뢰도나 확률이 아닙니다.',
    '마지막 조회 시각 기준이며 실제 검토·소진·마감 시점에는 재조회가 필요합니다.'];
  const options = { now, weeklyPerHour, fiveHourPerHour, accessSlots: schedule.accessSlots };
  const simulate = rows => simulateUsage(snapshot, schedule.workSlots, rows, options);
  const baseline = simulate([]);
  if (baseline.state !== 'ready') return incomplete('한도·작업 소모율의 단위와 범위를 확인하고 최신 상태를 재조회하세요.');
  schedule.assumptions.push(`계산 범위: Unix 초 ${now}부터 ${baseline.horizonAt}까지 입력된 전체 작업과 마지막 안전 마감을 포함합니다.`);
  const firstTimes = first ? candidateTimes(schedule.accessSlots, now, first.deadlineAt, 64, depletionTimes(baseline)) : [];
  const nextOnlyTimes = next ? candidateTimes(schedule.accessSlots, now, next.deadlineAt, 32, depletionTimes(baseline)) : [];
  schedule.lastSafeAt = firstTimes.at(-1) ?? null;
  let selected = baseline, results = [], rows = [];
  // Unknown effects are reviewed provisionally, never scored as invented refills.
  const provisional = firstTimes.length && credits.some(c => c.resetType !== 'codexRateLimits') ? first
    : !firstTimes.length && nextOnlyTimes.length && next.resetType !== 'codexRateLimits' ? next : null;
  if (provisional) {
    const times = provisional === first ? firstTimes : nextOnlyTimes;
    const at = times.at(-1);
    rows = [{ number: provisional.number, at }];
    selected = simulate(rows);
    if (selected.state === 'ready') {
      // Even if only the next effect is unknown, do not present a complete optimized plan.
      selected = { ...selected, state: 'uncertain', segments: selected.segments.filter(s => s.toAt <= at),
        metrics: { ...selected.metrics,
        totalUsedPercent: null, totalDiscardedPercent: null, blockedWorkHours: null } };
    }
    plan.warnings.push('리셋권 효과를 확인할 수 없어 접속 가능한 안전 마감 검토만 잠정 안내하며 전체 최적화와 이후 수치를 보류합니다.');
    const interval = schedule.accessSlots.find(s => at >= s.startAt && at <= s.endAt);
    schedule.recommendedStart = times.find(t => t >= interval.startAt); schedule.recommendedEnd = at;
    plan.title = `${provisional.number}번 리셋권을 잠정 재조회·검토하세요.`;
    plan.reason = '접속 가능한 마감 구간의 잠정 안내입니다. 효과 미확인으로 전체 사용 계획을 최적화할 수 없습니다.';
  } else {
    for (const at of firstTimes) {
      const firstRows = [{ number: first.number, at }], firstResult = simulate(firstRows);
      results.push(firstResult);
      if (!next) continue;
      // baseline + 64*(1+30) + 32 second-only + 2 sensitivities = 2019 <= 2048.
      const secondTimes = candidateTimes(schedule.accessSlots, at + 1, next.deadlineAt, 30, depletionTimes(firstResult));
      for (const secondAt of secondTimes) results.push(simulate([...firstRows, { number: next.number, at: secondAt }]));
    }
    for (const at of nextOnlyTimes) results.push(simulate([{ number: next.number, at }]));
    selected = chooseRedemptionPlan([...results, baseline]);
    if (!selected) return incomplete('동일 계산 범위의 유효한 후보를 비교할 수 없습니다. 입력을 확인하세요.');
    const at = reviewAt(selected);
    const interval = at === null ? null : schedule.accessSlots.find(s => at >= s.startAt && at <= s.endAt);
    const equivalent = results.filter(r => r.state === 'ready' && comparePrimary(r, selected) === 0
      && (r.firstUseAt === null) === (selected.firstUseAt === null) && reviewAt(r) !== null
      && interval && reviewAt(r) >= interval.startAt && reviewAt(r) <= interval.endAt);
    if (equivalent.length) {
      schedule.recommendedStart = Math.min(...equivalent.map(reviewAt));
      schedule.recommendedEnd = Math.max(...equivalent.map(reviewAt));
    }
    rows = selected.events.filter(e => e.kind === 'credit-use').map(e => ({ number: e.creditNumber, at: e.at }));
    schedule.candidates = [...results].filter(r => r.state === 'ready').sort(compare).slice(0, 8)
      .map(r => ({ firstUseAt: r.firstUseAt, nextUseAt: r.nextUseAt, totalUsedPercent: r.metrics.totalUsedPercent,
        totalDiscardedPercent: r.metrics.totalDiscardedPercent, expiredCredits: r.metrics.expiredCredits }));
    schedule.scenarios = [['느림', 0.75], ['기준', 1], ['빠름', 1.25]].map(([label, factor]) => {
      const s = factor === 1 ? selected : simulateUsage(snapshot, schedule.workSlots, rows, { ...options, speedFactor: factor });
      if (s.state !== 'ready') plan.warnings.push('민감도 소모율이 수치 범위를 벗어나 해당 시나리오 계산을 보류합니다.');
      return { label, factor, totalUsedPercent: s.metrics.totalUsedPercent,
        totalDiscardedPercent: s.metrics.totalDiscardedPercent, expiredCredits: s.metrics.expiredCredits };
    });
    plan.title = first ? '작업·접속 일정에 맞춰 리셋권을 재조회·검토하세요.' : '현재 잔여량과 자연 리셋을 확인하세요.';
    plan.reason = first ? '평가한 후보 중 만료 위험, 총 활용량, 버릴 주간 잔여량을 비교한 가정의 추천 구간입니다.'
      : '계획 가능한 날짜가 있는 리셋권이 없어 현재 사용량을 자연 리셋까지 계산합니다. 복구는 재조회로 확인하세요.';
  }
  const recommendedReview = selected.events.find(e => e.kind === 'credit-use');
  if (recommendedReview) {
    const recommendedCredit = recommendedReview.creditNumber === first?.number ? first : next;
    schedule.reviewCreditNumber = recommendedCredit.number;
    schedule.reviewRemainingPercent = recommendedCredit === first ? selected.metrics.firstRemainingPercent : selected.metrics.nextRemainingPercent;
    schedule.lastSafeAt = candidateTimes(schedule.accessSlots, now, recommendedCredit.deadlineAt, 32).at(-1) ?? null;
    plan.targetAt = recommendedCredit.deadlineAt;
  }
  if (first && !firstTimes.length) {
    const secondCopy = recommendedReview ? ` ${next.number}번 리셋권만 접속 가능한 구간에서 재조회 후 검토하도록 제안합니다.` : '';
    plan.title = recommendedReview ? `${next.number}번 리셋권의 검토 구간을 확인하세요.` : '첫 리셋권의 안전 마감 전 접속이 어렵습니다.';
    plan.reason = `첫 안전 마감 전 접속 가능한 구간이 없습니다. 첫 리셋권을 검토했다고 가정하지 않으며 만료 위험이 있습니다.${secondCopy} ${plan.reason}`;
  }
  Object.assign(schedule, { nextUseAt: selected.nextUseAt, totalUsedPercent: selected.metrics.totalUsedPercent,
    totalDiscardedPercent: selected.metrics.totalDiscardedPercent, firstRemainingPercent: selected.metrics.firstRemainingPercent,
    expiredCredits: selected.metrics.expiredCredits, blockedWorkHours: selected.metrics.blockedWorkHours,
    workSlots: selected.workSlots, accessSlots: selected.accessSlots });
  plan.firstUseAt = selected.firstUseAt; plan.remainingAtTarget = selected.metrics.firstRemainingPercent;
  plan.nextRemainingPercent = selected.metrics.nextRemainingPercent;
  plan.nextGapSeconds = next && plan.firstUseAt !== null ? Math.max(0, next.deadlineAt - plan.firstUseAt) : null;
  plan.events = selected.events; plan.segments = selected.segments;
  plan.warnings = [...new Set([...plan.warnings, ...selected.warnings])];
  if (plan.coverage === 'partial') plan.reason = `조회된 항목 중 ${plan.reason}`;
  plan.code = 'work-schedule';
  return plan;
}
