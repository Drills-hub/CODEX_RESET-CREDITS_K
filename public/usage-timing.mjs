function result(code, title, reason, targetAt = null) {
  return { code, title, reason, targetAt };
}

// Recommendations use the last successful read, never a predicted refill.
export function recommendUsage(snapshot, { now = Date.now(), stale = false, refreshing = false } = {}) {
  if (!snapshot) return result('not-ready', '조회 후 사용 시점을 안내합니다.', '5시간·주간 한도를 조회해 주세요.');
  if (refreshing) return result('refreshing', '사용량 재조회 중입니다.', '마지막 성공 결과를 갱신하고 있습니다. 조회가 끝난 뒤 사용 시점을 확인해 주세요.');
  if (stale || !Number.isFinite(now) || now < 0 || !Number.isSafeInteger(snapshot.queriedAt)
    || snapshot.queriedAt < 0 || snapshot.queriedAt * 1000 > now) {
    return result('refresh-needed', '최신 사용량 재조회가 필요합니다.', '이전 조회 값으로 사용 시점을 추천하지 않습니다. 새로고침해 주세요.');
  }
  if (snapshot.ordinaryUsageAllowed === false) return result('server-restricted', '서버에서 일반 사용을 제한했습니다.', '잔여율만으로 사용 가능 여부를 판단할 수 없습니다. 최신 상태를 재조회해 주세요.');
  const windows = ['five-hour', 'weekly'].map(kind => snapshot.usageWindows?.find(row => row.kind === kind));
  if (windows.some(row => !row || row.state !== 'complete' || !Number.isInteger(row.remainingPercent)
    || row.remainingPercent < 0 || row.remainingPercent > 100 || !Number.isSafeInteger(row.resetsAt) || row.resetsAt < 0)) {
    return result('incomplete', '사용 시점 추천을 보류합니다.', '5시간·주간 잔여율과 리셋 시각을 모두 확인할 수 있어야 추천할 수 있습니다.');
  }
  const [five, weekly] = windows;
  const nowSeconds = now / 1000;
  if (windows.some(row => row.resetsAt <= nowSeconds)) return result('refresh-needed', '리셋 후 사용량을 재조회해 주세요.', '리셋 시각이 지났습니다. 한도가 복구되었는지는 새로고침으로 확인하세요.');
  const depleted = windows.filter(row => row.remainingPercent === 0);
  if (depleted.length) return result('exhausted', '한도 리셋 후 재조회하세요.',
    `${depleted.map(row => row.kind === 'five-hour' ? '5시간' : '주간').join('·')} 잔여량이 0%입니다. 소진된 한도의 리셋 시각 이후 최신 상태를 확인하세요.`,
    Math.max(...depleted.map(row => row.resetsAt)));
  const balances = `마지막 조회 기준 5시간 ${five.remainingPercent}%, 주간 ${weekly.remainingPercent}%가 남았습니다.`;
  const weekIn = weekly.resetsAt - nowSeconds;
  if (weekly.remainingPercent <= 20 && weekIn > 86400) return result('weekly-budget', '필수 작업부터 사용하세요.',
    `${balances} 주간 리셋까지 24시간 넘게 남아 주간 한도가 먼저 소진될 수 있습니다.`, weekly.resetsAt);
  if (weekIn <= 86400) return result('weekly-reset', '주간 리셋 전 활용을 권장합니다.',
    `${balances} 주간 리셋까지 24시간 이내입니다. 필요한 작업에 남은 사용량을 활용하세요.`, weekly.resetsAt);
  if (five.resetsAt - nowSeconds <= 3600) return result('five-hour-reset', '현재 5시간 잔여량 활용을 권장합니다.',
    `${balances} 5시간 리셋까지 1시간 이내입니다. 주간 잔여량도 함께 확인하며 사용하세요.`, five.resetsAt);
  return result('ready', snapshot.ordinaryUsageAllowed === true ? '지금 사용 가능합니다.' : '잔여량 기준 지금 활용을 권장합니다.',
    `${balances} 두 한도에 여유가 있습니다. 실제 사용 가능 여부는 서버 상태에 따라 달라집니다.`, Math.min(five.resetsAt, weekly.resetsAt));
}

const DAY_SECONDS = 86400;
const HOUR_SECONDS = 3600;
const PLAN_SUSPENSIONS = new Set(['not-ready', 'refreshing', 'refresh-needed', 'server-restricted', 'incomplete']);
const CREDIT_COVERAGE = new Set(['complete', 'partial', 'count-only', 'unavailable']);
const finiteOrNull = value => Number.isFinite(value) ? value : null;
const clampPercent = value => Math.min(100, Math.max(0, value));
const balanceAfter = (percent, rate, seconds) => clampPercent(percent - rate * (seconds / DAY_SECONDS));
const planNumberFormatter = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 6 });

// A line reaching zero early is split so the chart never stretches depletion
// over the remainder of the interval. This is an estimate, not usage permission.
function planSegments(kind, fromAt, toAt, percent, rate) {
  if (toAt < fromAt || rate === null) return [];
  const depletionAt = finiteOrNull(fromAt + percent / rate * DAY_SECONDS);
  if (depletionAt !== null && depletionAt < toAt) {
    return [
      { kind, fromAt, toAt: depletionAt, fromPercent: percent, toPercent: 0 },
      { kind, fromAt: depletionAt, toAt, fromPercent: 0, toPercent: 0 },
    ];
  }
  return [{ kind, fromAt, toAt, fromPercent: percent,
    toPercent: balanceAfter(percent, rate, toAt - fromAt) }];
}

// Unlike recommendUsage's legacy millisecond API, all plan times are seconds.
// No read, redemption, model execution, history or predicted recurring resets.
export function buildUsagePlan(snapshot, {
  now = Date.now() / 1000, stale = false, refreshing = false,
  ratePerDay = null, rateSource = 'auto',
} = {}) {
  const coverage = CREDIT_COVERAGE.has(snapshot?.detailState) ? snapshot.detailState : 'unavailable';
  const rate = Number.isFinite(ratePerDay) && ratePerDay > 0 ? ratePerDay : null;
  const validWindows = Array.isArray(snapshot?.usageWindows)
    && snapshot.usageWindows.every(row => row && typeof row === 'object');
  const advice = recommendUsage(snapshot && !validWindows ? { ...snapshot, usageWindows: [] } : snapshot,
    { now: Number.isFinite(now) ? now * 1000 : NaN, stale, refreshing });
  const suspended = PLAN_SUSPENSIONS.has(advice.code);
  const plan = {
    state: suspended ? advice.code : 'ready', code: advice.code, title: advice.title, reason: advice.reason,
    queriedAt: Number.isSafeInteger(snapshot?.queriedAt) && snapshot.queriedAt >= 0 ? snapshot.queriedAt : null,
    targetAt: null, requiredRatePerDay: null, ratePerDay: rate, exhaustsAt: null, remainingAtTarget: null,
    rateSource: rateSource === 'manual' ? 'manual' : 'auto', coverage,
    firstCredit: null, nextCredit: null, firstUseAt: null,
    nextGapSeconds: null, nextRequiredRatePerDay: null, nextRemainingPercent: null,
    events: [], segments: [], warnings: [],
  };
  if (Number.isFinite(now) && now >= 0) {
    plan.events.push({ kind: 'now', at: now, label: '계산 기준 시각', creditNumber: null, assumed: false });
  }
  if (suspended) return plan;

  const five = snapshot.usageWindows.find(row => row.kind === 'five-hour');
  const weekly = snapshot.usageWindows.find(row => row.kind === 'weekly');
  const credits = Array.isArray(snapshot.credits) ? snapshot.credits : [];
  const detailed = coverage === 'complete' || coverage === 'partial';
  const knownExpiry = row => row?.expiryState === 'known' && Number.isSafeInteger(row.expiresAt) && row.expiresAt >= 0;
  const eligible = detailed ? credits.filter(row => row?.status === 'available' && knownExpiry(row)
    && row.expiresAt > now && Number.isSafeInteger(row.number) && row.number > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.number - b.number) : [];
  const toCredit = row => row ? {
    number: row.number, title: typeof row.title === 'string' ? row.title : '리셋권',
    expiresAt: row.expiresAt, deadlineAt: Math.max(now, row.expiresAt - HOUR_SECONDS),
    resetType: row.resetType === 'codexRateLimits' ? 'codexRateLimits' : 'unknown',
  } : null;
  plan.firstCredit = toCredit(eligible[0]);
  plan.nextCredit = toCredit(eligible[1]);
  const first = plan.firstCredit;
  const next = plan.nextCredit;

  if (coverage === 'partial') plan.warnings.push('리셋권 상세가 일부만 조회되어 조회된 항목 중에서만 계획합니다.');
  if (!detailed) plan.warnings.push('리셋권 상세 만료 시각을 확인할 수 없어 개수로 사용 일정을 추정하지 않습니다.');
  if (detailed && credits.some(row => row?.status === 'available' && knownExpiry(row) && row.expiresAt <= now)) {
    plan.warnings.push('이미 만료된 리셋권은 계획에서 제외했습니다. 최신 상태를 재조회하세요.');
  }
  if (detailed && credits.some(row => row?.status === 'available' && !knownExpiry(row))) {
    plan.warnings.push('만료 시각을 확인할 수 없는 리셋권은 일정에서 제외했습니다.');
  }
  if (five.remainingPercent === 0) plan.warnings.push('5시간 잔여량이 0%라 일반 사용이 제한될 수 있습니다. 최신 상태를 재조회하고 실제 사용 허용 여부를 확인하세요.');
  else plan.warnings.push('주간 소모량 예상과 별도로 5시간 한도의 제한을 확인하세요. 반복 리셋이나 지속 사용을 보장하지 않습니다.');
  if (weekly.remainingPercent === 0) plan.warnings.push('주간 잔여량이 0%라 일반 사용이 제한될 수 있습니다. 재조회 후 리셋권 사용 여부를 검토하세요.');
  if (snapshot.ordinaryUsageAllowed !== true) plan.warnings.push('실제 사용 허용 여부를 확인한 경우에만 실행할 수 있는 조건부 계획입니다.');
  if (rate !== null) plan.warnings.push('하루 소모량이 일정하게 유지된다는 낙관적 가정의 예상이며 실제 사용 가능 여부를 보장하지 않습니다.');
  else plan.warnings.push('유효한 소모 속도가 없어 소진 예상과 잔여율 그래프를 표시하지 않습니다.');
  if (first && next && next.expiresAt === first.expiresAt) {
    plan.warnings.push('첫·다음 리셋권의 동일 만료 시각에 주의하세요. 일찍 첫 항목을 검토해도 만료가 겹칩니다.');
  }

  plan.targetAt = Math.min(weekly.resetsAt, first?.deadlineAt ?? weekly.resetsAt);
  const durationDays = (plan.targetAt - now) / DAY_SECONDS;
  plan.requiredRatePerDay = durationDays > 0 ? finiteOrNull(weekly.remainingPercent / durationDays) : null;
  if (durationDays === 0) plan.warnings.push('안전 마감까지 시간이 없어 즉시 재조회하고 리셋권 사용 여부를 검토하세요.');
  if (rate !== null) {
    plan.exhaustsAt = finiteOrNull(now + weekly.remainingPercent / rate * DAY_SECONDS);
    plan.remainingAtTarget = balanceAfter(weekly.remainingPercent, rate, plan.targetAt - now);
    plan.segments.push(...planSegments('estimate', now, plan.targetAt, weekly.remainingPercent, rate));
  }

  plan.events.push({ kind: 'weekly-reset', at: weekly.resetsAt,
    label: '주간 리셋 예정 · 실제 복구는 재조회로 확인', creditNumber: null, assumed: false });
  if (first && weekly.resetsAt > first.deadlineAt) {
    plan.firstUseAt = Math.max(now, Math.min(plan.exhaustsAt ?? first.deadlineAt, first.deadlineAt));
    const scope = coverage === 'partial' ? '조회된 항목 중 ' : '';
    plan.code = rate === null ? 'credit-deadline' : plan.exhaustsAt !== null && plan.exhaustsAt <= first.deadlineAt
      ? 'credit-after-depletion' : 'credit-before-expiry';
    plan.title = rate === null ? '첫 리셋권의 안전 마감을 확인하세요.' : '주간 잔여량 활용 후 첫 리셋권을 검토하세요.';
    plan.reason = rate === null
      ? `${scope}첫 리셋권 만료 1시간 전을 안전 마감으로 삼아 재조회 후 사용 여부를 검토하세요. 소진 예상 시각은 확인할 수 없습니다.`
      : plan.code === 'credit-after-depletion'
        ? `${scope}현재 주간 잔여량을 소진한 뒤 재조회하고 첫 리셋권 사용을 검토하세요.`
        : `${scope}안전 마감까지 현재 주간 잔여량을 활용한 뒤 재조회하고 첫 리셋권 사용을 검토하세요. 예상 잔여 ${planNumberFormatter.format(plan.remainingAtTarget)}%를 포기할 수 있습니다.`;
    plan.events.push({ kind: 'credit-use', at: plan.firstUseAt,
      label: rate === null ? '첫 리셋권 안전 마감 · 재조회 후 사용 검토' : '첫 리셋권 사용 검토 시각 · 소진 속도 가정',
      creditNumber: first.number, assumed: true });
    if (first.resetType !== 'codexRateLimits') {
      plan.warnings.push('첫 리셋권의 리셋 효과를 확인할 수 없어 이후 주간 100% 충전 시나리오를 계산하지 않습니다.');
    }
    if (next) {
      plan.nextGapSeconds = Math.max(0, next.deadlineAt - plan.firstUseAt);
      if (plan.nextGapSeconds === 0) plan.warnings.push('다음 안전 마감과의 간격이 0초입니다. 동시 마감이므로 속도로 해결할 수 없습니다.');
      if (first.resetType === 'codexRateLimits') {
        plan.warnings.push('첫 리셋권 사용 후 주간 100% 충전을 가정한 시나리오이며 실제 복구를 보장하지 않습니다.');
        const scenarioEnd = Math.min(next.deadlineAt, weekly.resetsAt);
        if (weekly.resetsAt <= next.deadlineAt) {
          plan.warnings.push('다음 안전 마감 전에 주간 자연 리셋에 도달하면 계산을 중단합니다. 리셋 시각에 재조회하세요.');
        } else {
          plan.nextRequiredRatePerDay = plan.nextGapSeconds > 0 ? finiteOrNull(100 / (plan.nextGapSeconds / DAY_SECONDS)) : null;
          plan.nextRemainingPercent = rate === null ? null : balanceAfter(100, rate, plan.nextGapSeconds);
        }
        plan.segments.push(...planSegments('scenario', plan.firstUseAt, scenarioEnd, 100, rate));
      }
    }
  } else if (first) {
    plan.code = 'natural-reset-first';
    plan.title = '주간 자연 리셋을 먼저 확인하세요.';
    plan.reason = `${coverage === 'partial' ? '조회된 항목 중 ' : ''}첫 리셋권 안전 마감보다 주간 리셋이 먼저이거나 같습니다. 리셋 시각에 재조회하고 리셋권 필요 여부를 판단하세요.`;
  }
  if (five.remainingPercent === 0 || weekly.remainingPercent === 0) {
    const depleted = [five, weekly].filter(row => row.remainingPercent === 0);
    const restriction = `${depleted.map(row => row.kind === 'five-hour' ? '5시간' : '주간').join('·')} 잔여량이 0%라 일반 사용이 제한될 수 있습니다. 재조회로 실제 잔여량과 사용 허용 여부를 확인하세요.`;
    if (first && plan.firstUseAt === now) {
      plan.title = '첫 리셋권을 즉시 재조회하고 사용 여부를 검토하세요.';
      plan.reason = `${coverage === 'partial' ? '조회된 항목 중 ' : ''}첫 리셋권 ${rate === null ? '안전 마감' : '검토 시각'}이 현재이므로 즉시 재조회하고 첫 리셋권 사용 여부를 검토하세요.`;
      if (plan.remainingAtTarget !== null && plan.remainingAtTarget > 0) plan.reason += ` 예상 잔여 ${planNumberFormatter.format(plan.remainingAtTarget)}%를 포기할 수 있습니다.`;
      if (rate === null) plan.reason += ' 소진 예상 시각은 확인할 수 없습니다.';
      plan.reason += ` ${restriction}`;
    } else if (first) {
      if (plan.firstUseAt !== null) plan.title = '사용 제한과 첫 리셋권 안전 마감을 함께 확인하세요.';
      plan.reason = `${restriction} 실제 사용이 허용되는 경우에만 다음 계획을 활용하세요. ${plan.reason}`;
    } else {
      plan.title = '소진된 한도를 재조회하세요.';
      plan.reason = `${advice.reason} ${restriction}`;
    }
  }
  if (snapshot.ordinaryUsageAllowed !== true) plan.reason += ' 실제 사용이 허용되는지 확인한 경우에만 활용하세요.';
  for (const row of [first, next]) {
    if (row) plan.events.push({ kind: 'credit-expiry', at: row.expiresAt,
      label: `${row.number}번 리셋권 만료 예정`, creditNumber: row.number, assumed: false });
  }
  plan.events.sort((a, b) => a.at - b.at);
  return plan;
}
