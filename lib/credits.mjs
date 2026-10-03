import { AppError } from './errors.mjs';
export function timestamp(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000 ? value : null;
}
export function normalizeCredits(result, now = Date.now()) {
  const summary = result?.rateLimitResetCredits;
  const base = { queriedAt: Math.floor(now / 1000), availableCount: null, detailState: 'unavailable', credits: [] };
  if (summary == null) return base;
  if (!Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) throw new AppError('INVALID_DATA');
  base.availableCount = summary.availableCount;
  if (summary.credits == null) return { ...base, detailState: 'count-only' };
  if (!Array.isArray(summary.credits) || summary.credits.length > 10000) throw new AppError('INVALID_DATA');
  const statuses = new Set(['available', 'redeeming', 'redeemed', 'unknown']);
  base.credits = summary.credits.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new AppError('INVALID_DATA');
    const expiresAt = timestamp(row.expiresAt);
    return {
      title: typeof row.title === 'string' && row.title.trim() ? row.title.slice(0, 300) : '리셋권',
      status: statuses.has(row.status) ? row.status : 'unknown',
      grantedAt: timestamp(row.grantedAt), expiresAt,
      expiryState: row.expiresAt === null ? 'none' : expiresAt === null ? 'unknown' : 'known',
    };
  }).sort((a, b) => {
    if (a.expiryState !== 'known') return b.expiryState === 'known' ? 1 : 0;
    return b.expiryState === 'known' ? a.expiresAt - b.expiresAt : -1;
  }).map((row, index) => ({ number: index + 1, ...row }));
  base.detailState = base.credits.length < base.availableCount ? 'partial' : 'complete';
  return base;
}
