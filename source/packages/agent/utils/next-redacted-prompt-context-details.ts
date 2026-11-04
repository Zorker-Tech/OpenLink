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
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import { buildPromptContextUsageTree } from "./prompt-context-usage-tree.ts"
import { buildPromptTokenBreakdownSnapshot, type PromptTokenBreakdownParams } from "./prompt-token-breakdown.ts"

export interface PromptTokenDetailsRedactionCodec<Snapshot, UsageTree, StoredBreakdown, StoredUsageTree> {
  decodeBreakdown(value: StoredBreakdown): Snapshot
  encodeBreakdown(value: Snapshot, privacyMode: PrivacyMode): StoredBreakdown
  encodeUsageTree(value: UsageTree, privacyMode: PrivacyMode): StoredUsageTree
}

export interface RedactedPromptTokenDetails<StoredBreakdown = unknown, StoredUsageTree = unknown> {
  breakdown?: StoredBreakdown | undefined
  promptContextUsageTree?: StoredUsageTree | undefined
}

export interface PromptTokenDetailsState<StoredBreakdown = unknown, StoredUsageTree = unknown> {
  // The same field also carries the running counts the summarizer watches, so it is described as the
  // redacted details plus those counts rather than as the details alone.
  tokenDetails: RedactedPromptTokenDetails<StoredBreakdown, StoredUsageTree> & {
    readonly usedTokens?: number | undefined
    readonly maxTokens?: number | undefined
  }
  getPrivacyMode(): PrivacyMode
}

export interface PromptTokenDetailsConfig {
  featureFlags?: { promptContextUsageTree?: boolean | undefined } | undefined
}

export function computeNextRedactedPromptContextDetails<StoredBreakdown, StoredUsageTree>(
  ctx: Context,
  config: PromptTokenDetailsConfig,
  stateHandler: PromptTokenDetailsState<StoredBreakdown, StoredUsageTree>,
  params: PromptTokenBreakdownParams,
  codec: PromptTokenDetailsRedactionCodec<
    ReturnType<typeof buildPromptTokenBreakdownSnapshot>,
    ReturnType<typeof buildPromptContextUsageTree>,
    StoredBreakdown,
    StoredUsageTree
  >,
): RedactedPromptTokenDetails<StoredBreakdown, StoredUsageTree> {
  using span = createSpan(ctx.withName("nextRedactedPromptContextDetails"))
  const tracedCtx = span.ctx
  const previousRedacted = stateHandler.tokenDetails.breakdown
  const previousUsageTree = stateHandler.tokenDetails.promptContextUsageTree
  const promptContextUsageTreeEnabled = config.featureFlags?.promptContextUsageTree === true
  span.span.setAttribute("promptContextUsageTreeEnabled", promptContextUsageTreeEnabled)
  const previousSnapshot = previousRedacted
    ? codec.decodeBreakdown(previousRedacted)
    : undefined
  const breakdownSnapshot = buildPromptTokenBreakdownSnapshot(tracedCtx, { ...params, previousSnapshot })
  const privacyMode = stateHandler.getPrivacyMode()
  return {
    breakdown: codec.encodeBreakdown(breakdownSnapshot, privacyMode),
    promptContextUsageTree: promptContextUsageTreeEnabled
      ? codec.encodeUsageTree(
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
