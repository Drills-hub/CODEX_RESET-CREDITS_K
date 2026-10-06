import { AppError } from './errors.mjs';
import { createHash } from 'node:crypto';
import { normalizeUsage, timestamp } from './usage.mjs';
export function normalizeCredits(result, now = Date.now()) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AppError('INCOMPATIBLE');
  if (!Object.hasOwn(result, 'rateLimits') || !result.rateLimits || typeof result.rateLimits !== 'object' || Array.isArray(result.rateLimits)) throw new AppError('INCOMPATIBLE');
  const summary = result?.rateLimitResetCredits;
  const base = { queriedAt: Math.floor(now / 1000), availableCount: null, detailState: 'unavailable', credits: [],
    usageWindows: normalizeUsage(result.rateLimits),
    ordinaryUsageAllowed: typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null };
  if (summary == null) return base;
  if (typeof summary !== 'object' || Array.isArray(summary)) throw new AppError('INCOMPATIBLE');
  if (!Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) throw new AppError('INCOMPATIBLE');
  base.availableCount = summary.availableCount;
  if (summary.credits == null) return { ...base, detailState: 'count-only' };
  if (!Array.isArray(summary.credits)) throw new AppError('INCOMPATIBLE');
  if (summary.credits.length > 10000) throw new AppError('INVALID_DATA');
  const statuses = new Set(['available', 'redeeming', 'redeemed', 'unknown']);
  base.credits = summary.credits.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) throw new AppError('INCOMPATIBLE');
    const expiresAt = timestamp(row.expiresAt);
    return {
      ...(typeof row.id === 'string' && row.id.trim()
        ? { reminderKey: createHash('sha256').update(JSON.stringify(['reset-credit', row.id])).digest('hex') }
        : {}),
      title: typeof row.title === 'string' && row.title.trim() ? row.title.slice(0, 300) : '리셋권',
      status: statuses.has(row.status) ? row.status : 'unknown',
      resetType: row.resetType === 'codexRateLimits' ? 'codexRateLimits' : 'unknown',
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
