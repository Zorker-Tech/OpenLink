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

export function getBackgroundSummarizationTriggerThreshold(
  maxTokens: number,
  props: BackgroundSummarizationProps,
): number | undefined {
  if (maxTokens <= 0) return undefined;
  const candidates: number[] = [];
  if (props.unusedTokensThresholdToStartBackgroundSummarization !== undefined) {
    candidates.push(maxTokens - props.unusedTokensThresholdToStartBackgroundSummarization);
  }
  if (props.unusedPercentTokensThresholdToStartBackgroundSummarization !== undefined) {
    candidates.push(
      maxTokens * (1 - props.unusedPercentTokensThresholdToStartBackgroundSummarization),
    );
  }
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

export function shouldStartBackgroundSummarization(
  usedTokens: number,
  maxTokens: number,
  props: BackgroundSummarizationProps,
): boolean {
  const threshold = getBackgroundSummarizationTriggerThreshold(maxTokens, props);
  return threshold !== undefined && usedTokens >= threshold;
}

export function shouldPersistBackgroundSummarization(
  usedTokens: number,
  maxTokens: number,
  props: BackgroundSummarizationProps,
): boolean {
  const unusedTokens = maxTokens - usedTokens;
  return shouldStartBackgroundSummarization(usedTokens, maxTokens, props) && (
    props.unusedTokensThresholdToPersistBackgroundSummarization !== undefined &&
      unusedTokens <= props.unusedTokensThresholdToPersistBackgroundSummarization ||
    props.unusedPercentTokensThresholdToPersistBackgroundSummarization !== undefined &&
      unusedTokens / maxTokens <= props.unusedPercentTokensThresholdToPersistBackgroundSummarization
  );
}
