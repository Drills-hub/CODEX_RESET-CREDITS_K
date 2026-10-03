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
