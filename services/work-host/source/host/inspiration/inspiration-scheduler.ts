/** The stochastic clock behind a Bot's curiosity subscription. */
import type { InspirationCadence, InspirationConfig, InspirationState } from "./inspiration-contracts.ts";

const HOUR = 60 * 60_000;

export function inspirationDayKey(now: number, timeZone: string | undefined): string {
  const date = new Date(now);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Exponential inter-arrival time, clamped so a random draw cannot starve or spam. */
export function poissonDelay(cadence: InspirationCadence, random: () => number): number {
  const uniform = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, random()));
  const delay = -cadence.meanIntervalMs * Math.log(uniform);
  return Math.round(Math.min(cadence.maxIntervalMs, Math.max(cadence.minIntervalMs, delay)));
}

export function resetUsageIfNeeded(state: InspirationState, now: number, timeZone: string | undefined): InspirationState {
  const dayKey = inspirationDayKey(now, timeZone);
  if (state.usage.dayKey === dayKey) return state;
  return { ...state, usage: { dayKey, usd: 0, tokens: 0, runs: 0 } };
}

export function computeNextFireAt(input: {
  now: number;
  config: InspirationConfig;
  random: () => number;
}): number {
  const delay = poissonDelay(input.config.cadence, input.random);
  let next = input.now + delay;
  if (input.random() < input.config.cadence.burstChance) {
    next += Math.max(10 * 60_000, Math.round(delay / 3));
  }
  return Math.round(next);
}

export function isDue(state: InspirationState, now: number): boolean {
  return state.nextFireAt !== null && state.nextFireAt <= now;
}

/**
 * The dynamic trade-off score the global tick uses to choose which due Bot
 * gets the floor. It rewards overdue subscriptions, useful feedback
 * and a clear identity, and adds a little jitter so the same Bot does
 * not always win.
 */
export function inspirationPriority(input: {
  state: InspirationState;
  instructions: string;
  description: string;
  now: number;
  random: () => number;
}): number {
  const cadence = input.state.config.cadence;
  const overdue = input.state.nextFireAt === null
    ? 0
    : Math.min(3, Math.max(0, (input.now - input.state.nextFireAt) / cadence.meanIntervalMs));
  const feedbackTotal = input.state.feedback.useful + input.state.feedback.notUseful;
  const engagement = (input.state.feedback.useful + 1) / (feedbackTotal + 2);
  const identity = input.instructions ? 1 : input.description ? 0.6 : 0.3;
  return overdue * 0.35 + engagement * 0.2 + identity * 0.15 + input.random() * 0.15;
}

export function cadenceLabel(cadence: InspirationCadence): string {
  const hours = Math.round(cadence.meanIntervalMs / HOUR);
  return hours >= 24 ? `about every ${Math.round(hours / 24)} day(s)` : `about every ${hours} hour(s)`;
}
