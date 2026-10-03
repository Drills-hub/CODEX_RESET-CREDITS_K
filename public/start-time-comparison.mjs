const definitions = [['now', '지금'], ['five-hour', '5시간 리셋 후'], ['weekly', '주간 리셋 후']];
const kinds = ['five-hour', 'weekly'];
const labels = { 'five-hour': '5시간', weekly: '주간' };
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;
const percent = value => Number.isInteger(value) && value >= 0 && value <= 100;

// Only compare reset times from this read. Future balances and permission stay unknown.
export function compareStartTimes(snapshot, { now = Date.now(), stale = false } = {}) {
  const queriedAt = timestamp(snapshot?.queriedAt) ? snapshot.queriedAt : null;
  const restriction = snapshot?.ordinaryUsageAllowed === false ? ' 마지막 조회에서 서버가 일반 사용을 제한했습니다.' : '';
  function suspended(state, message) {
    return { state, queriedAt, message: message + restriction, rows: definitions.map(([key, title]) => ({
      key, title, startAt: null, state, message: message + restriction, resetKinds: [], carriedLimits: [],
    })) };
  }
  if (!snapshot) return suspended('not-ready', '조회 후 작업 시작 시각을 비교합니다.');
  if (stale || !Number.isFinite(now) || now < 0 || !timestamp(Math.floor(now / 1000)) || queriedAt === null || queriedAt * 1000 > now) {
    return suspended('refresh-needed', '최신 사용량을 재조회한 뒤 시작 시각을 비교해 주세요.');
  }
  const source = Array.isArray(snapshot.usageWindows) ? snapshot.usageWindows : [];
  const windows = kinds.map(kind => {
    const matches = source.filter(row => row?.kind === kind);
    const row = matches.length === 1 ? matches[0] : null;
    const identified = row?.windowDurationMins === (kind === 'five-hour' ? 300 : 10080);
    return { kind, resetsAt: identified && timestamp(row.resetsAt) ? row.resetsAt : null,
      remainingPercent: identified && percent(row.remainingPercent) ? row.remainingPercent : null,
      complete: identified && row.state === 'complete' && timestamp(row.resetsAt) && percent(row.remainingPercent) };
  });
  const seconds = now / 1000;
  if (windows.some(row => row.resetsAt !== null && row.resetsAt <= seconds)) {
    return suspended('refresh-needed', '조회된 리셋 시각이 지났습니다. 새 리셋 시각과 잔여량을 재조회해 주세요.');
  }
  const complete = windows.every(row => row.complete);
  const message = complete ? '마지막 조회의 한도와 리셋 예정 시각을 비교합니다. 미래 잔여량과 사용 권한은 시작 전에 재조회해 주세요.'
    : '일부 한도 정보를 확인할 수 없습니다. 알려진 리셋 시각만 표시하며 사용 가능 판단은 보류합니다.';
  const rows = definitions.map(([key, title]) => {
    const startAt = key === 'now' ? Math.floor(seconds) : windows.find(row => row.kind === key).resetsAt;
    const resetKinds = key === 'now' || startAt === null ? [] : windows.filter(row => row.resetsAt !== null && row.resetsAt <= startAt).map(row => row.kind);
    const carriedLimits = windows.filter(row => !resetKinds.includes(row.kind)).map(({ kind, remainingPercent, resetsAt }) => ({ kind, remainingPercent, resetsAt }));
    const base = { key, title, startAt, resetKinds, carriedLimits };
    if (!complete) return { ...base, state: 'incomplete', message: '정보가 부족해 사용 가능 판단을 보류합니다. 시작 전에 재조회해 주세요.' + restriction };
    if (snapshot.ordinaryUsageAllowed === false) return { ...base, state: key === 'now' ? 'server-restricted' : 'recheck',
      message: '마지막 조회에서 서버가 일반 사용을 제한했습니다. 리셋 예정 시각만으로 제한 해제를 판단할 수 없어 시작 전에 재조회해야 합니다.' };
    const depleted = carriedLimits.filter(row => row.remainingPercent === 0);
    if (depleted.length) return { ...base, state: key === 'now' ? 'exhausted' : 'remaining-limit',
      message: `${depleted.map(row => `${labels[row.kind]} 한도가 마지막 조회에서 0%였습니다`).join(' · ')}. 해당 한도의 리셋 시각도 함께 확인하고 시작 전에 재조회해 주세요.` };
    if (key !== 'now') return { ...base, state: 'recheck', message: '조회된 한도의 리셋 예정 시각입니다. 이때의 잔여량과 사용 권한은 시작 전에 재조회해 주세요.' };
    return { ...base, state: snapshot.ordinaryUsageAllowed === true ? 'ready' : 'conditional',
      message: snapshot.ordinaryUsageAllowed === true ? '마지막 조회 기준 두 한도에 잔여량이 있고 서버가 일반 사용을 허용했습니다. 실제 시작 시 최신 상태를 확인하세요.'
        : '마지막 조회 기준 두 한도에 잔여량이 있습니다. 서버의 사용 허용 정보가 없어 시작 전에 재확인이 필요합니다.' };
  });
  return { state: complete ? 'complete' : 'incomplete', queriedAt, message: message + restriction, rows };
}
