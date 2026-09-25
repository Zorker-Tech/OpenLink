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
import { prepareMessagesForCompaction } from "../../agent-summarization/prepare-messages.ts";
import type { PrivacyMode } from "../../redaction/privacy-mode.ts";
import {
  EVAL_ENFORCED_SELF_SUMMARY_TOKEN_LIMIT,
} from "../utils/config-overrides.ts";
import {
  SELF_SUMMARY_CONTEXT_WINDOW_FRACTION,
  SELF_SUMMARY_NUM_TURNS,
} from "./constants.ts";
import { estimateTokenCount } from "./token-estimate.ts";

export interface SelfSummaryMessage {
  readonly role: string;
  readonly content: unknown;
  readonly providerOptions?: {
    readonly cursor?: {
      readonly isSummary?: unknown;
      readonly [key: string]: unknown;
    } | undefined;
    readonly [key: string]: unknown;
  } | undefined;
  readonly _privacyMode: PrivacyMode;
  readonly [key: string]: unknown;
}

export interface SelfSummaryTokenDetails {
  readonly usedTokens?: number | undefined;
  readonly maxTokens?: number | undefined;
}

const logger = createLogger("@slate/agent");

export function findLastUserMessageIndex(
  messages: readonly SelfSummaryMessage[],
  options?: { readonly includeSummaryMessages?: boolean | undefined } | null,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      (options?.includeSummaryMessages || !message.providerOptions?.cursor?.isSummary)
    ) {
      return index;
    }
  }
  return -1;
}

function getMessagesToSummarize(messages: readonly SelfSummaryMessage[]): SelfSummaryMessage[] {
  const { messagesForSummarization } = prepareMessagesForCompaction(messages);
  return messagesForSummarization as SelfSummaryMessage[];
}

function countTurns(messages: readonly SelfSummaryMessage[]): number {
  if (messages.length < 2) return 0;
  const messagesToBeSummarized = getMessagesToSummarize(messages);
  let turnCount = 0;
  for (const message of messagesToBeSummarized) {
    if (message.role === "user" && !message.providerOptions?.cursor?.isSummary) {
      turnCount++;
    }
  }
  return turnCount;
}

export function shouldPerformSelfSummary(
  messages: readonly SelfSummaryMessage[],
  tokenDetails: SelfSummaryTokenDetails | null | undefined,
  ctx: Context | undefined,
  configTokenLimit: number | undefined,
): boolean {
  const turnCount = countTurns(messages);
  if (turnCount >= SELF_SUMMARY_NUM_TURNS) return true;

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
  const fractionLimit = tokenDetails?.maxTokens !== undefined && tokenDetails.maxTokens > 0
    ? Math.floor(tokenDetails.maxTokens * SELF_SUMMARY_CONTEXT_WINDOW_FRACTION)
    : undefined;
  const tokenLimit = evalOverrideLimit ?? configTokenLimit ?? fractionLimit;
  if (tokenLimit === undefined) return false;
  return tokenCount >= tokenLimit;
}
