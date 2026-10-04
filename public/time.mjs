const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function formatKst(seconds) {
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime())) return '확인 불가';
  const parts = Object.fromEntries(formatter.formatToParts(new Date(seconds * 1000)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST (UTC+09:00)`;
}
export function remainingTime(expiresAt, now = Date.now()) {
  if (!Number.isSafeInteger(expiresAt)) return '만료 시각 확인 불가';
  const seconds = Math.ceil((expiresAt * 1000 - now) / 1000);
  if (seconds <= 0) return '만료 시각 경과: 새로고침 필요';
  const pad = x => String(x).padStart(2, '0');
  return `${Math.floor(seconds / 86400)}일 ${pad(Math.floor(seconds / 3600) % 24)}시간 ${pad(Math.floor(seconds / 60) % 60)}분 ${pad(seconds % 60)}초`;
}
export function emptyMessage(snapshot) {
  if (snapshot.detailState === 'unavailable') return '이 계정에서 리셋권 정보를 확인할 수 없습니다.';
  if (snapshot.availableCount === 0) return '사용 가능한 리셋권이 없습니다.';
  if (snapshot.detailState === 'count-only') return '상세 정보가 제공되지 않았습니다. 만료 시각은 현재 계정에서 확인할 수 없습니다.';
  if (snapshot.detailState === 'partial') return `전체 ${snapshot.availableCount}개 중 ${snapshot.credits.length}개 상세 조회`;
  return '조회한 리셋권의 만료 시각을 확인해 주세요.';
}
