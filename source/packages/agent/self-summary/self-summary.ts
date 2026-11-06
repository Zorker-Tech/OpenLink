/**
 * Whether a conversation should be summarized before it is continued.
 *
 * Two triggers decide it, and either is enough. A conversation that has gone on for enough turns is worth
 * summarizing whatever its size, because the work has moved on and the beginning is no longer what the
 * model needs. And a conversation that has grown close to the window it is being sent into is summarized
 * before it is refused: the limit is the session's own if it set one, then an override a test harness may
 * impose, then the window's own fraction — in that order, because a caller that named a limit knows
 * something the fraction does not.
 *
 * The size is taken from what the platform already counted when it has a count, and estimated from the
 * conversation when it does not, counting tool arguments and results as well as text, since a conversation
 * about code is mostly those. What counts as a turn is the same question the compaction itself asks: the
 * user's own messages, not the summaries written from earlier ones.
 */

import type { Context } from "../../context/context.ts";
import { createLogger } from "../../context/index.ts";
import {
  EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT,
} from "../utils/config-overrides.ts";
import { estimateTokenCount } from "./token-estimate.ts";
import {
  countSummarizableUserTurns,
  type SelfSummaryMessage,
} from "./self-summary-message-window.ts";
import {
  reachedSelfSummaryTokenLimit,
  reachedSelfSummaryTurnLimit,
} from "./self-summary-trigger-policy.ts";

export { findLastUserMessageIndex } from "./self-summary-message-window.ts";
export type { SelfSummaryMessage } from "./self-summary-message-window.ts";

export interface SelfSummaryTokenDetails {
  readonly usedTokens?: number | undefined;
  readonly maximumTokens?: number | undefined;
}

const logger = createLogger("@slate/agent");

export function shouldPerformSelfSummary(
  messages: readonly SelfSummaryMessage[],
  tokenDetails: SelfSummaryTokenDetails | null | undefined,
  ctx: Context | undefined,
  configTokenLimit: number | undefined,
): boolean {
  const turnCount = countSummarizableUserTurns(messages);
  if (reachedSelfSummaryTurnLimit(turnCount)) return true;

  const tokenCount = tokenDetails?.usedTokens !== undefined &&
      Number.isFinite(tokenDetails.usedTokens) && tokenDetails.usedTokens > 0
    ? tokenDetails.usedTokens
    : estimateTokenCount(messages, { includeNonTextContent: true });
  const evalOverrideLimit = ctx !== undefined
    ? EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT(ctx)
    : undefined;
  if (evalOverrideLimit !== undefined && ctx !== undefined) {
    logger.info(ctx, "[self-summary] using eval override token limit", {
      evalOverrideLimit,
      configTokenLimit,
    });
  }
  return reachedSelfSummaryTokenLimit({
    tokenCount,
    evalOverrideLimit,
    configTokenLimit,
    maxTokens: tokenDetails?.maximumTokens,
  });
}
