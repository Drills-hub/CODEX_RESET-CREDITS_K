import { formatKst } from './time.mjs';
const HOUR = 3600, DAY = 86400;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000;

// All input/output times are Unix seconds. No consumption or future balance estimates.
export function recommendReset(snapshot, { now = Date.now() / 1000, stale = false, refreshing = false } = {}) {
  const base = { code: 'not-ready', credit: null, targetAt: null, deadlineAt: null, queriedAt: snapshot?.queriedAt ?? null, title: '조회 후 리셋 추천을 안내합니다.', reason: '리셋권 정보를 조회해 주세요.' };
  const result = (code, title, reason, extra = {}) => ({ ...base, code, title, reason, ...extra });
  const requery = () => result('refresh-needed', '최신 상태를 재조회해 주세요.', '이전 조회의 추천·만료 또는 한도 리셋 시각이 지났거나 최신 정보를 확인하지 못했습니다. 새로고침해 주세요.');
  if (refreshing) return result('refreshing', '리셋권 재조회 중입니다.', '조회가 완료되면 추천을 다시 안내합니다.');
  if (!snapshot) return base;
  if (stale || !Number.isFinite(now) || now < 0 || !validTime(snapshot.queriedAt) || snapshot.queriedAt > now) return requery();
  if (snapshot.ordinaryUsageAllowed === false) return result('server-restricted', '서버에서 일반 사용을 제한했습니다.', '최신 상태를 재조회하고 실제 사용 허용 여부를 확인해 주세요.');
  if (snapshot.usageWindows?.some(row => validTime(row.resetsAt) && row.resetsAt <= now)) return requery();
  if (snapshot.availableCount === 0) return result('no-credits', '사용 가능한 리셋권이 없습니다.', '한도와 다음 리셋 시각은 상단에서 확인하세요.');
  if (snapshot.detailState === 'unavailable') return result('unavailable', '리셋권 정보를 확인할 수 없습니다.', '현재 계정의 리셋권 정보를 다시 조회해 주세요.');
  if (snapshot.detailState === 'count-only') return result('count-only', '리셋권 만료 시각을 확인할 수 없습니다.', '개수만 제공되어 사용 시각을 추천할 수 없습니다.');
  const available = (snapshot.credits ?? []).filter(row => row.status === 'available');
  const dated = available.filter(row => row.expiryState === 'known' && validTime(row.expiresAt));
  if (dated.some(row => row.expiresAt > snapshot.queriedAt && row.expiresAt <= now)) return requery();
  const credit = dated.filter(row => row.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt || a.number - b.number)[0];
  if (!credit) {
    if (available.some(row => row.expiryState === 'unknown' || row.expiryState === 'known' && !validTime(row.expiresAt))) return result('unknown-expiry', '만료 시각 확인 불가', '기한을 추정하지 않습니다. 리셋 상세에서 확인하세요.');
    if (available.some(row => row.expiryState === 'none')) return result('no-expiry', '만료 기한이 없는 리셋권입니다.', '필요한 시점에 사용 여부를 확인하세요.');
    return result(dated.length ? 'expired' : 'unavailable', dated.length ? '미래 만료 일정이 없습니다.' : '사용 가능한 리셋권 상세를 확인할 수 없습니다.', '리셋 상세와 최신 조회 결과를 확인하세요.');
  }
  const prefix = snapshot.detailState === 'partial' ? '조회된 항목 기준입니다. ' : '';
  const unknown = available.some(row => !dated.includes(row) && row.expiryState !== 'none') ? '일부 리셋권의 만료 시각은 확인되지 않았습니다. ' : '';
  const context = prefix + unknown;
  const left = credit.expiresAt - now;
  if (left >= 7 * DAY) return result('free-use', '자유롭게 사용', `${context}리셋권 만료까지 7일 이상 남았습니다. 필요한 작업에 현재 한도를 활용하세요.`, { credit });
  if (left > DAY) return result('prepare', '리셋권 사용을 준비하세요.', `${context}남은 기한을 확인하고 현재 주간·5시간 한도를 사용한 뒤 리셋권 사용을 준비하세요.`, { credit });
  const deadlineAt = credit.expiresAt - HOUR;
  const roundedAt = Math.floor(deadlineAt / HOUR) * HOUR;
  if ([deadlineAt, roundedAt].some(at => at > snapshot.queriedAt && at <= now)) return requery();
  const immediate = roundedAt <= now;
  const hour = formatKst(roundedAt).slice(11, 13);
  return result(immediate ? 'use-now' : 'deadline', immediate ? '지금 사용을 추천합니다!' : `${hour}시 사용을 추천합니다!`,
    `${context}현재 주간·5시간 잔여 한도를 가능한 만큼 사용한 뒤, 만료 전 권장 마감에 리셋권을 사용하세요. 권장 마감: ${formatKst(deadlineAt)}. 실제 사용 전에 최신 상태를 확인하세요.`,
    { credit, deadlineAt, targetAt: immediate ? Math.floor(now) : deadlineAt });
}
