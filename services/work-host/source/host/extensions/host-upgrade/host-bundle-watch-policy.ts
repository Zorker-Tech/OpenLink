function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}

export function hostBundleWatchInitialDelayMs(baseMs: number, jitterRatio: number, random: () => number = Math.random): number {
  if (!(baseMs > 0) || !(jitterRatio > 0)) return 0;
  return Math.round(bounded(random(), 0, 1) * baseMs);
}

export function hostBundleWatchNextDelayMs(baseMs: number, jitterRatio: number, random: () => number = Math.random): number {
  const interval = baseMs > 0 ? baseMs : 0;
  const spread = bounded(jitterRatio, 0, 1);
  if (spread === 0) return interval;
  const centeredSample = bounded(random(), 0, 1) * 2 - 1;
  return Math.max(0, Math.round(interval + centeredSample * interval * spread));
}
