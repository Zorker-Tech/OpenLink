/**
 * What a turn cost, in tokens.
 *
 * Counts arrive as wide integers and are clamped to what a number can hold without losing precision, so a report never
 * carries an unusable value; the totals a turn reports and the usage a turn-ended event carries are the same numbers,
 * and merging them adds each kind up.
 */

/** The counts a turn reports: what it read, what it wrote, what it read from and wrote to its cache, and what it reasoned. */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
}

/** What a turn-ended event carries: the same counts as wide integers, each absent when the turn did not report it. */
export interface TurnEndedUsage {
  readonly inputTokens?: bigint;
  readonly outputTokens?: bigint;
  readonly cacheReadTokens?: bigint;
  readonly cacheWriteTokens?: bigint;
  readonly reasoningTokens?: bigint;
}

/** Zero and the largest safe integer, as the wide integers the event carries. */
const ZERO = 0n;
const LARGEST_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A wide count clamped into what a number holds without losing precision. */
export function toSafeTokenCount(count: bigint): number {
  if (count <= ZERO) return 0;
  if (count >= LARGEST_SAFE) return Number.MAX_SAFE_INTEGER;
  return Number(count);
}

/** Whether a turn-ended event says nothing about usage at all. */
function saysNothing(event: TurnEndedUsage): boolean {
  return event.inputTokens == null && event.outputTokens == null && event.cacheReadTokens == null && event.cacheWriteTokens == null && event.reasoningTokens == null;
}

/** One wide count as a report count, with an absent one counting as zero. */
function countOrZero(count: bigint | undefined): number {
  return toSafeTokenCount(count ?? ZERO);
}

/** The usage a turn-ended event carries, or undefined when the event carried no usage. */
export function turnUsageFromTurnEnded(event: TurnEndedUsage): TurnUsage | undefined {
  if (saysNothing(event)) return undefined;
  const usage: TurnUsage = {
    inputTokens: countOrZero(event.inputTokens),
    outputTokens: countOrZero(event.outputTokens),
    cacheReadTokens: countOrZero(event.cacheReadTokens),
    cacheWriteTokens: countOrZero(event.cacheWriteTokens),
  };
  return event.reasoningTokens == null ? usage : { ...usage, reasoningTokens: toSafeTokenCount(event.reasoningTokens) };
}

/** The input tokens of a usage: what the turn was billed for reading. */
export const totalInputTokens = (usage: TurnUsage): number => usage.inputTokens;

/** Two counts added without leaving the safe range. */
export const addTokenCounts = (left: number, right: number): number => Math.min(Number.MAX_SAFE_INTEGER, left + right);

/** Two usages merged count by count, or whichever one exists when the other does not. */
export function mergeTurnUsage(previous: TurnUsage | undefined, next: TurnUsage | undefined): TurnUsage | undefined {
  if (previous == null) return next;
  if (next == null) return previous;
  const usage: TurnUsage = {
    inputTokens: addTokenCounts(previous.inputTokens, next.inputTokens),
    outputTokens: addTokenCounts(previous.outputTokens, next.outputTokens),
    cacheReadTokens: addTokenCounts(previous.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: addTokenCounts(previous.cacheWriteTokens, next.cacheWriteTokens),
  };
  if (previous.reasoningTokens == null && next.reasoningTokens == null) return usage;
  return { ...usage, reasoningTokens: addTokenCounts(previous.reasoningTokens ?? 0, next.reasoningTokens ?? 0) };
}
