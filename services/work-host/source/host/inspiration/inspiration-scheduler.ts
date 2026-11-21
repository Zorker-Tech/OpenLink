/** The stochastic clock behind a Bot's curiosity subscription. */
import type { InspirationCadence, InspirationConfig, InspirationState, InspirationTrigger } from "./inspiration-contracts.ts";
import { OBSERVATION_MAX_AGE_MS } from './inspiration-observations.ts';

const HOUR = 60 * 60_000;
const NOMINATION_DELAY_MS = 2 * 60_000;
const FILE_REVIEW_INTERVAL_MS = 30_000;
const TRAFFIC_REVIEW_INTERVAL_MS = 10 * 60_000;

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

type ScheduledReview = { trigger: Exclude<InspirationTrigger, 'manual'>; at: number };

export function nextInspirationReview(state: InspirationState, now: number): ScheduledReview | null {
  const reviews: ScheduledReview[] = [];
  const consider = (trigger: ScheduledReview['trigger'], at: number | null | undefined) => {
    if (at != null) reviews.push({ trigger, at });
  };
  const recent = state.observations.filter(({ observedAt }) => observedAt >= now - OBSERVATION_MAX_AGE_MS);
  const firstFile = recent.find(({ files }) => files.length > 0);
  const observation = firstFile ?? recent[0];
  if (observation) {
    const previous = state.ledger.findLast(({ trigger }) => trigger === 'event')?.createdAt ?? 0;
    consider('event', Math.max(observation.observedAt + 5_000, previous + (firstFile ? FILE_REVIEW_INTERVAL_MS : TRAFFIC_REVIEW_INTERVAL_MS)));
  }
  if (state.nominations[0]) consider('nomination', state.nominations[0].createdAt + NOMINATION_DELAY_MS);
  consider('follow-up', state.followUp?.dueAt);
  consider('stochastic', state.nextFireAt);
  const first = reviews.sort((a, b) => a.at - b.at)[0];
  return first ? { ...first, at: Math.max(first.at, state.retryAt ?? 0) } : null;
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
