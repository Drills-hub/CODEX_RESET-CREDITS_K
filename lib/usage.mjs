export function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000 ? value : null;
}

// Durations identify windows; their positions in the upstream response do not.
export function normalizeUsage(rateLimits) {
  const rows = [rateLimits.primary, rateLimits.secondary].filter(row => row && typeof row === 'object' && !Array.isArray(row));
  return [['five-hour', 300], ['weekly', 10080]].map(([kind, windowDurationMins]) => {
    const base = { kind, windowDurationMins, usedPercent: null, remainingPercent: null, resetsAt: null, state: 'unavailable' };
    const matches = rows.filter(row => row.windowDurationMins === windowDurationMins);
    if (!matches.length) return base;
    if (matches.length > 1) return { ...base, state: 'invalid' };
    const row = matches[0];
    const usedPercent = Number.isInteger(row.usedPercent) && row.usedPercent >= 0 && row.usedPercent <= 100 ? row.usedPercent : null;
    const resetsAt = timestamp(row.resetsAt);
    const invalid = (row.usedPercent != null && usedPercent === null) || (row.resetsAt != null && resetsAt === null);
    return { ...base, usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetsAt,
      state: invalid ? 'invalid' : usedPercent === null || resetsAt === null ? 'partial' : 'complete' };
  });
}
