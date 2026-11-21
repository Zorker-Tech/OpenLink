/** The stochastic clock behind a Bot's curiosity subscription. */
import type { InspirationCadence, InspirationConfig, InspirationQuietHours, InspirationState } from "./inspiration-contracts.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function localParts(now: number, timeZone: string | undefined): { dayKey: string; hour: number } {
  const date = new Date(now);
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour);
    return {
      dayKey: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number.isFinite(hour) ? (hour === 24 ? 0 : hour) : date.getUTCHours(),
    };
  } catch {
    return {
      dayKey: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`,
      hour: date.getUTCHours(),
    };
  }
}

export function inspirationDayKey(now: number, timeZone: string | undefined): string {
  return localParts(now, timeZone).dayKey;
}

function inQuietWindow(hour: number, quiet: InspirationQuietHours): boolean {
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function isQuietHour(now: number, quiet: InspirationQuietHours, timeZone: string | undefined): boolean {
  return inQuietWindow(localParts(now, timeZone).hour, quiet);
}

/** Walk forward in hourly steps until the quiet window is over. Bounded to two days. */
export function advanceOutOfQuietHours(now: number, quiet: InspirationQuietHours, timeZone: string | undefined): number {
  if (!isQuietHour(now, quiet, timeZone)) return now;
  // Move to the next whole hour first, so a fire at 23:30 leaves at 08:00,
  // not at 08:30 after eight hourly steps.
  let candidate = Math.ceil(now / HOUR) * HOUR;
  for (let index = 0; index < 48 && isQuietHour(candidate, quiet, timeZone); index += 1) {
    candidate += HOUR;
  }
  return candidate;
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

export function dailyRuns(state: InspirationState, now: number, timeZone: string | undefined): number {
  return state.usage.dayKey === inspirationDayKey(now, timeZone) ? state.usage.runs : 0;
}

export function dailySpend(state: InspirationState, now: number, timeZone: string | undefined): number {
  return state.usage.dayKey === inspirationDayKey(now, timeZone) ? state.usage.usd : 0;
}

export function computeNextFireAt(input: {
  now: number;
  config: InspirationConfig;
  random: () => number;
  timeZone: string | undefined;
  /** A nomination or manual request can pull the next fire earlier. */
  notBefore?: number | null;
}): number | null {
  if (!input.config.enabled) return null;
  const delay = poissonDelay(input.config.cadence, input.random);
  let next = input.now + delay;
  if (input.notBefore !== null && input.notBefore !== undefined) next = Math.min(next, input.notBefore);
  next = advanceOutOfQuietHours(next, input.config.quietHours, input.timeZone);
  // A burst is a second draw inside the same window, still subject to the
  // quiet window and the hard daily cap at fire time.
  if (input.random() < input.config.cadence.burstChance) {
    next = advanceOutOfQuietHours(next + Math.max(10 * 60_000, Math.round(delay / 3)), input.config.quietHours, input.timeZone);
  }
  return Math.round(next);
}

export function isDue(state: InspirationState, now: number): boolean {
  return state.config.enabled && state.nextFireAt !== null && state.nextFireAt <= now;
}

/**
 * The dynamic trade-off score the global tick uses to choose which due Bot
 * gets the floor. It rewards overdue subscriptions, useful feedback, budget
 * headroom and a clear identity, and adds a little jitter so the same Bot does
 * not always win.
 */
export function inspirationPriority(input: {
  state: InspirationState;
  instructions: string;
  description: string;
  budgetUsdPerDay: number | null;
  now: number;
  timeZone: string | undefined;
  random: () => number;
}): number {
  const cadence = input.state.config.cadence;
  const overdue = input.state.nextFireAt === null
    ? 0
    : Math.min(3, Math.max(0, (input.now - input.state.nextFireAt) / cadence.meanIntervalMs));
  const feedbackTotal = input.state.feedback.useful + input.state.feedback.notUseful;
  const engagement = (input.state.feedback.useful + 1) / (feedbackTotal + 2);
  const budget = input.budgetUsdPerDay ?? input.state.config.budgetUsdPerDay;
  const headroom = budget === null
    ? 1
    : Math.min(1, Math.max(0, (budget - dailySpend(input.state, input.now, input.timeZone)) / Math.max(budget, 0.01)));
  const identity = input.instructions ? 1 : input.description ? 0.6 : 0.3;
  return overdue * 0.35 + engagement * 0.2 + headroom * 0.15 + identity * 0.15 + input.random() * 0.15;
}

export function cadenceLabel(cadence: InspirationCadence): string {
  const hours = Math.round(cadence.meanIntervalMs / HOUR);
  return hours >= 24 ? `about every ${Math.round(hours / 24)} day(s)` : `about every ${hours} hour(s)`;
}

export const INSPIRATION_DAY_MS = DAY;
