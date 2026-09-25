/**
 * The next token details of a conversation, in the form a reader may see.
 *
 * The breakdown and the context tree are computed from the prompt itself — which is unredacted text —
 * and then converted to their redacted forms before they are stored on the conversation state, so the
 * text they describe never travels with them. The conversion happens once, here, rather than at every
 * place that reads the details.
 *
 * Two things make the next details depend on the previous ones. The breakdown reuses what the last
 * turn learned about each category's token ratio, which is why the previous breakdown is converted
 * back — the arithmetic needs the numbers, and they are the same numbers on either side of the privacy
 * boundary. The tree, on the other hand, is not recomputed unless the feature is on: when it is off,
 * the previous tree is carried over untouched rather than replaced with a fresh one nobody asked for.
 */

import { createSpan } from "../../context/telemetry.ts"
import type { Context } from "../../context/context.ts"
import { PrivacyCapability } from "../../redaction/classification.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import {
  fromRedactedPromptTokenBreakdownSnapshot,
  toRedactedPromptContextUsageTree,
  toRedactedPromptTokenBreakdownSnapshot,
} from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { buildPromptContextUsageTree } from "./prompt-context-usage-tree.ts"
import { buildPromptTokenBreakdownSnapshot, type PromptTokenBreakdownParams } from "./prompt-token-breakdown.ts"

type RedactedBreakdown = ReturnType<typeof toRedactedPromptTokenBreakdownSnapshot>
type RedactedUsageTree = ReturnType<typeof toRedactedPromptContextUsageTree>

export interface RedactedPromptTokenDetails {
  breakdown?: RedactedBreakdown | undefined
  promptContextUsageTree?: RedactedUsageTree | undefined
}

export interface PromptTokenDetailsState {
  // The same field also carries the running counts the summarizer watches, so it is described as the
  // redacted details plus those counts rather than as the details alone.
  tokenDetails: RedactedPromptTokenDetails & {
    readonly usedTokens?: number | undefined
    readonly maxTokens?: number | undefined
  }
  getPrivacyMode(): PrivacyMode
}

export interface PromptTokenDetailsConfig {
  featureFlags?: { promptContextUsageTree?: boolean | undefined } | undefined
}

export function computeNextRedactedPromptContextDetails(
  ctx: Context,
  config: PromptTokenDetailsConfig,
  stateHandler: PromptTokenDetailsState,
  params: PromptTokenBreakdownParams,
): RedactedPromptTokenDetails {
  using span = createSpan(ctx.withName("nextRedactedPromptContextDetails"))
  const tracedCtx = span.ctx
  const previousRedacted = stateHandler.tokenDetails.breakdown
  const previousUsageTree = stateHandler.tokenDetails.promptContextUsageTree
  const promptContextUsageTreeEnabled = config.featureFlags?.promptContextUsageTree === true
  span.span.setAttribute("promptContextUsageTreeEnabled", promptContextUsageTreeEnabled)
  const previousSnapshot = previousRedacted
    ? fromRedactedPromptTokenBreakdownSnapshot(previousRedacted, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
    : undefined
  const breakdownSnapshot = buildPromptTokenBreakdownSnapshot(tracedCtx, { ...params, previousSnapshot })
  const privacyMode = stateHandler.getPrivacyMode()
  return {
    breakdown: toRedactedPromptTokenBreakdownSnapshot(breakdownSnapshot, privacyMode),
    promptContextUsageTree: promptContextUsageTreeEnabled
      ? toRedactedPromptContextUsageTree(
        buildPromptContextUsageTree({
          messages: params.messages,
          tools: params.tools,
          descriptionProps: params.descriptionProps,
          breakdown: breakdownSnapshot,
        }),
        privacyMode,
      )
      : previousUsageTree,
  }
}
