import { kstDateKey } from './expiry-calendar.mjs';
import { formatKst } from './time.mjs';

function validClock(nowMs) {
  return Number.isFinite(nowMs) && nowMs >= 0 && kstDateKey(Math.floor(nowMs / 1000)) !== null;
}

export function formatSummaryTime(seconds, { nowMs = Date.now() } = {}) {
  const date = kstDateKey(seconds);
  if (!date || !validClock(nowMs)) return '확인 불가';
  const today = kstDateKey(Math.floor(nowMs / 1000));
  const time = formatKst(seconds).slice(11, 16);
  if (date === today) return `오늘 ${time}`;
  if (date.slice(0, 4) === today.slice(0, 4)) return `${date.slice(5).replace('-', '/')} ${time}`;
  return `${date} ${time}`;
}

export function formatSummaryRemaining(seconds, { nowMs = Date.now() } = {}) {
  if (!kstDateKey(seconds) || !validClock(nowMs)) return '확인 불가';
  const remaining = seconds * 1000 - nowMs;
  if (remaining <= 0) return '시각 경과 · 재조회 필요';
  if (remaining < 60000) return '1분 미만 남음';
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return `${days ? `${days}일 ` : ''}${days || hours ? `${hours}시간 ` : ''}${minutes % 60}분 남음`;
}

const summaries = {
  'free-use': ['neutral', '만료까지 7일 이상 남았습니다.'],
  prepare: ['neutral', '현재 한도를 사용한 뒤 리셋권 사용을 준비하세요.'],
  deadline: ['deadline', '현재 한도를 가능한 만큼 사용한 뒤 권장 마감에 확인하세요.'],
  'use-now': ['deadline', '만료 전에 최신 상태를 확인하고 사용을 검토하세요.'],
  refreshing: ['pending', '조회가 완료되면 추천을 다시 안내합니다.'],
  'refresh-needed': ['error', '이전 조회 결과로 사용 시점을 판단할 수 없습니다.'],
  'server-restricted': ['error', '새로고침 후 실제 사용 허용 여부를 확인하세요.'],
};

export function buildRecommendationDisplay(recommendation, snapshot) {
  const [tone, summaryReason] = summaries[recommendation.code] ?? ['neutral', recommendation.reason];
  const partial = snapshot?.detailState === 'partial';
  const unknown = (snapshot?.credits ?? []).some(row => row.status === 'available'
    && (row.expiryState === 'unknown' || row.expiryState === 'known' && kstDateKey(row.expiresAt) === null));
  return {
    title: recommendation.title.replace(/!$/u, '.'), summaryReason, detailReason: recommendation.reason,
    deadlineAt: recommendation.deadlineAt, tone,
    scopeNote: [partial ? '조회된 항목 기준' : '', unknown ? '일부 만료 시각 확인 불가' : ''].filter(Boolean).join(' · '),
  };
}
