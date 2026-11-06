/**
 * Compute the Slate token breakdown and optional prompt-context tree for the next turn.
 *
 * These are first-party values in memory. The state-message adapter applies the conversation's privacy
 * policy when it writes a persisted snapshot, so prompt-derived text does not leak through storage.
 *
 * Two things make the next details depend on the previous ones. The breakdown reuses what the last
 * turn learned about each category's token ratio. The tree is not recomputed unless the feature is on:
 * when it is off, the previous tree is carried over untouched rather than replaced with a fresh one.
 */

import { createSpan } from "../../context/telemetry.ts"
import type { Context } from "../../context/context.ts"
import { buildPromptContextUsageTree } from "./prompt-context-usage-tree.ts"
import { buildPromptTokenBreakdownSnapshot, type PromptTokenBreakdownParams } from "./prompt-token-breakdown.ts"
import type {
  PromptContextUsageTreeValue,
  PromptTokenBreakdownSnapshotValue,
} from "./prompt-usage-contracts.ts"

export interface PromptTokenDetailsState {
  readonly tokenDetails: {
    readonly breakdown?: PromptTokenBreakdownSnapshotValue | undefined
    readonly contextTree?: PromptContextUsageTreeValue | undefined
  }
}

export interface PromptTokenDetailsConfig {
  featureFlags?: { promptContextUsageTree?: boolean | undefined } | undefined
}

export function computeNextPromptContextDetails(
  ctx: Context,
  config: PromptTokenDetailsConfig,
  stateHandler: PromptTokenDetailsState,
  params: PromptTokenBreakdownParams,
): {
  readonly breakdown: PromptTokenBreakdownSnapshotValue
  readonly contextTree?: PromptContextUsageTreeValue
} {
  using span = createSpan(ctx.withName("nextPromptContextDetails"))
  const tracedCtx = span.ctx
  const previousSnapshot = stateHandler.tokenDetails.breakdown
  const previousUsageTree = stateHandler.tokenDetails.contextTree
  const promptContextUsageTreeEnabled = config.featureFlags?.promptContextUsageTree === true
  span.span.setAttribute("promptContextUsageTreeEnabled", promptContextUsageTreeEnabled)
  const breakdownSnapshot = buildPromptTokenBreakdownSnapshot(tracedCtx, { ...params, previousSnapshot })
  const contextTree = promptContextUsageTreeEnabled
    ? buildPromptContextUsageTree({
        messages: params.messages,
        tools: params.tools,
        descriptionProps: params.descriptionProps,
        breakdown: breakdownSnapshot,
      })
    : previousUsageTree
  return {
    breakdown: breakdownSnapshot,
    ...(contextTree === undefined ? {} : { contextTree }),
  }
}
