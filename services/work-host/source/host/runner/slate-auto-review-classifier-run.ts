/** Runs the bounded classifier request and turns its answer into a Slate review decision. */
import type { Context } from "../../packages/context/context.ts"
import { smartModeClassifierExecutorResource } from "../../packages/agent-exec/smart-mode-classifier-operation.ts"
import type { RemoteExecManager } from "../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../packages/agent-exec/resource-provider.ts"
import { getConversationId } from "../../packages/agent/utils/request-scope.ts"
import { executeAutoReviewClassifierThroughInterop } from "../../adapters/interop/agent/auto-review-classifier-adapter.ts"
import type { SlateClassifierConversationMessage } from "../../packages/agent/smart-mode-classifier-context.ts"
import {
  decideAutoReviewClassifierResult,
  SLATE_AUTO_REVIEW_BLOCK_REASON,
  SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
} from "./auto-review-classifier-contracts.ts"
import type { AutoReviewClassifierDecision } from "./auto-review-classifier-contracts.ts"
import type { SlateAutoReviewRiskTarget } from "./auto-review-classifier-contracts.ts"

export { SLATE_AUTO_REVIEW_BLOCK_REASON, SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS } from "./auto-review-classifier-contracts.ts"
export type { AutoReviewClassifierDecision } from "./auto-review-classifier-contracts.ts"

export async function runSlateAutoReviewClassifier(args: {
  readonly ctx: Context
  readonly resourceAccessor: ResourceAccessor<RemoteExecManager>
  readonly toolCallId: string
  readonly mode: "shadow" | "enforce"
  readonly buildTarget: () => SlateAutoReviewRiskTarget
  readonly loadConversationContext: () => Promise<readonly SlateClassifierConversationMessage[]>
  readonly workspacePaths?: readonly string[]
  readonly errorReason: string
}): Promise<AutoReviewClassifierDecision> {
  try {
    const executor = args.resourceAccessor.get(smartModeClassifierExecutorResource)
    const parentConversationId = getConversationId(args.ctx)
    const target = args.buildTarget()
    const conversationContext = await args.loadConversationContext()
    const classifierResult = await executeAutoReviewClassifierThroughInterop({
      context: args.ctx,
      executor,
      toolCallId: args.toolCallId,
      parentConversationId,
      target,
      conversationContext,
      mode: args.mode,
      ...(args.workspacePaths === undefined ? {} : { workspacePaths: args.workspacePaths }),
      options: {
        suppressToolCallIdLogging: true,
        maxAttempts: SLATE_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
      },
    })
    return decideAutoReviewClassifierResult(
      classifierResult,
      args.errorReason,
      SLATE_AUTO_REVIEW_BLOCK_REASON,
    )
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") throw error
    return { kind: "reject", reason: args.errorReason }
  }
}
