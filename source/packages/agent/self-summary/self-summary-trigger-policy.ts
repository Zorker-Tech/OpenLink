import {
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
} from "./constants.ts";

export interface SelfSummaryTokenPolicyInput {
  readonly tokenCount: number;
  readonly evalOverrideLimit?: number | undefined;
  readonly configTokenLimit?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export function reachedSelfSummaryTurnLimit(turnCount: number): boolean {
  return turnCount >= SELF_SUMMARY_NUM_TURNS;
}

export function reachedSelfSummaryTokenLimit(input: SelfSummaryTokenPolicyInput): boolean {
  const fractionLimit = input.maxTokens !== undefined && input.maxTokens > 0
    ? Math.floor(input.maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION)
    : undefined;
  const tokenLimit = input.evalOverrideLimit ?? input.configTokenLimit ?? fractionLimit;
  return tokenLimit !== undefined && input.tokenCount >= tokenLimit;
}
