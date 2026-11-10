export const BASE_POLL_INTERVAL_MS = 5 * 60_000;
export const MIN_POLL_INTERVAL_MS = 30_000;
export const POLL_JITTER_FRACTION = 0.3;
export const BOOTSTRAP_TIMEOUT_MS = 30_000;
export const GATE_READY_TIMEOUT_MS = 10_000;

export function computePollDelayMs(args: {
  readonly baseIntervalMs: number;
  readonly jitterRoll: number;
  readonly retryAfterMs?: number | undefined;
}): number {
  const jitteredDelay = Math.floor(args.baseIntervalMs * (1 + args.jitterRoll * POLL_JITTER_FRACTION));
  return args.retryAfterMs == null ? jitteredDelay : Math.max(args.retryAfterMs, jitteredDelay);
}

export function envGateOverride(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const encodedOverrides = env.SLATE_FEATURE_GATE_OVERRIDES;
  if (encodedOverrides == null || encodedOverrides.length === 0) return undefined;
  for (const encodedEntry of encodedOverrides.split(",")) {
    const [key, rawValue] = encodedEntry.split("=", 2).map((part) => part.trim());
    if (key !== name) continue;
    return rawValue === "1" || rawValue === "true" || rawValue === "on";
  }
  return undefined;
}

export function jitteredSlateExperimentPollIntervalMs(isDevBuild: boolean, random = Math.random): number {
  const baseInterval = isDevBuild ? MIN_POLL_INTERVAL_MS : BASE_POLL_INTERVAL_MS;
  return Math.floor(baseInterval * (1 + random() * POLL_JITTER_FRACTION));
}
