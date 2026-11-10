/**
 * When a conversation is compacted in the background, and when that work is kept.
 *
 * Compaction takes time, so it is started while the conversation still has room rather than when it runs
 * out: a threshold expressed either as an absolute number of unused tokens or as a fraction of the window,
 * whichever is reached first. A second pair of thresholds decides whether the finished summary is worth
 * keeping at all — with very little room left, the summary is persisted, and with more room it is discarded
 * and regenerated later, because a summary written from an older conversation is worse than one written
 * from the current one.
 */

export enum BackgroundSummarizationMode {
  Background = "Background",
  BackgroundAndPersistIfCompleted = "BackgroundAndPersistIfCompleted",
  WaitForCompletion = "WaitForCompletion",
  WaitForCompletionIfStarted = "WaitForCompletionIfStarted",
}

export interface BackgroundSummarizationProps {
  unusedTokensThresholdToStartBackgroundSummarization?: number | undefined;
  unusedPercentTokensThresholdToStartBackgroundSummarization?: number | undefined;
  unusedTokensThresholdToPersistBackgroundSummarization?: number | undefined;
  unusedPercentTokensThresholdToPersistBackgroundSummarization?: number | undefined;
  discardOnError?: boolean | undefined;
}

export const DISABLED_BACKGROUND_SUMMARIZATION_PROPS: BackgroundSummarizationProps = {
  unusedTokensThresholdToStartBackgroundSummarization: undefined,
  unusedPercentTokensThresholdToStartBackgroundSummarization: undefined,
  unusedTokensThresholdToPersistBackgroundSummarization: undefined,
  unusedPercentTokensThresholdToPersistBackgroundSummarization: undefined,
};

/** The point, in used tokens, at which an absolute allowance of unused tokens runs out. */
function usedAtAbsoluteThreshold(maxTokens: number, unusedTokens: number | undefined): number | undefined {
  return unusedTokens === undefined ? undefined : maxTokens - unusedTokens;
}

/** The same point for a fraction of the window: a tenth of the room left means nine tenths used. */
function usedAtFractionThreshold(maxTokens: number, unusedFraction: number | undefined): number | undefined {
  return unusedFraction === undefined ? undefined : maxTokens * (1 - unusedFraction);
}

/**
 * The moment compaction should start: the earliest of the thresholds the session set, in used tokens.
 *
 * A session that set none never starts one, and neither does a window with no room in it at all.
 */
export function getBackgroundSummarizationTriggerThreshold(maxTokens: number, props: BackgroundSummarizationProps): number | undefined {
  if (maxTokens <= 0) return undefined;
  const candidates = [
    usedAtAbsoluteThreshold(maxTokens, props.unusedTokensThresholdToStartBackgroundSummarization),
    usedAtFractionThreshold(maxTokens, props.unusedPercentTokensThresholdToStartBackgroundSummarization),
  ].filter((candidate): candidate is number => candidate !== undefined);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Whether a conversation has used enough of its window that a compaction should be started now. */
export function shouldStartBackgroundSummarization(usedTokens: number, maxTokens: number, props: BackgroundSummarizationProps): boolean {
  const startsAt = getBackgroundSummarizationTriggerThreshold(maxTokens, props);
  return startsAt !== undefined && usedTokens >= startsAt;
}

/** Whether the room left is little enough, by the absolute allowance the session set. */
function littleRoomByAbsolute(unusedTokens: number, props: BackgroundSummarizationProps): boolean {
  const allowance = props.unusedTokensThresholdToPersistBackgroundSummarization;
  return allowance !== undefined && unusedTokens <= allowance;
}

/** Whether the room left is little enough, by the fraction of the window the session set. */
function littleRoomByFraction(unusedTokens: number, maxTokens: number, props: BackgroundSummarizationProps): boolean {
  const fraction = props.unusedPercentTokensThresholdToPersistBackgroundSummarization;
  return fraction !== undefined && unusedTokens / maxTokens <= fraction;
}

/**
 * Whether a finished summary is worth keeping.
 *
 * Nothing is kept from a compaction that never started, and a summary written with room to spare is dropped: it was
 * made from a conversation that has since moved on, and one written later from the current conversation is better.
 */
export function shouldPersistBackgroundSummarization(usedTokens: number, maxTokens: number, props: BackgroundSummarizationProps): boolean {
  if (!shouldStartBackgroundSummarization(usedTokens, maxTokens, props)) return false;
  const unusedTokens = maxTokens - usedTokens;
  return littleRoomByAbsolute(unusedTokens, props) || littleRoomByFraction(unusedTokens, maxTokens, props);
}
