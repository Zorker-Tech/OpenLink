import { Struct } from "@bufbuild/protobuf"
import {
  SmartModeClassifierArgs,
  SmartModeClassifierDecision,
  SmartModeClassifierConversationMessage,
  type SmartModeClassifierResult,
  SmartModeRiskTarget,
} from "../proto/generated/agent/v1/smart_mode_classifier_exec_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { Executor } from "../../../packages/agent-exec/executor-resources.ts"
import { executeSmartModeClassifierWithMeasurement } from "./smart-mode-classifier-measurement-adapter.ts"
import type {
  AutoReviewClassifierResult,
  SlateAutoReviewRiskTarget,
} from "../../../host/runner/auto-review-classifier-contracts.ts"
import type { SlateClassifierConversationMessage } from "../../../packages/agent/smart-mode-classifier-context.ts"

export function encodeAutoReviewRiskTarget(target: SlateAutoReviewRiskTarget): SmartModeRiskTarget {
  return new SmartModeRiskTarget({
    action: target.action,
    arguments: Struct.fromJson(target.arguments as never),
  })
}

export function projectAutoReviewClassifierResult(result: SmartModeClassifierResult): AutoReviewClassifierResult {
  if (result.result.case !== "success") return { kind: "unavailable" }

  const { decision, blockReason, proposedAllowRule } = result.result.value
  if (decision === SmartModeClassifierDecision.BLOCK) {
    return {
      kind: "block",
      ...(blockReason === undefined ? {} : { blockReason }),
      ...(proposedAllowRule === undefined ? {} : { proposedAllowRule }),
    }
  }
  return decision === SmartModeClassifierDecision.ALLOW
    ? { kind: "allow" }
    : { kind: "unknown" }
}

export async function executeAutoReviewClassifierThroughInterop(input: {
  readonly context: Context
  readonly executor: Executor<SmartModeClassifierArgs, SmartModeClassifierResult>
  readonly toolCallId: string
  readonly parentConversationId: string | undefined
  readonly target: SlateAutoReviewRiskTarget
  readonly conversationContext: readonly SlateClassifierConversationMessage[]
  readonly mode: "shadow" | "enforce"
  readonly workspacePaths?: readonly string[]
  readonly options: NonNullable<Parameters<typeof executeSmartModeClassifierWithMeasurement>[5]>
}): Promise<AutoReviewClassifierResult> {
  const args = new SmartModeClassifierArgs({
    toolCallId: input.toolCallId,
    parentConversationId: input.parentConversationId!,
    target: encodeAutoReviewRiskTarget(input.target),
    conversationContext: input.conversationContext.map(message =>
      new SmartModeClassifierConversationMessage({ role: message.role, content: message.content })),
  })
  const result = await executeSmartModeClassifierWithMeasurement(
    input.context,
    input.executor,
    args,
    input.mode,
    input.workspacePaths,
    input.options,
  )
  return projectAutoReviewClassifierResult(result)
}
