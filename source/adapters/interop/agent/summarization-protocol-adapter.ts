import { AgentMode, PreCompactRequestQuery } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  ExecuteHookArgs,
  ExecuteHookRequest,
  type ExecuteHookResult,
} from "../proto/generated/agent/v1/exec_pb.ts"
import {
  toRedactedInteractionUpdate,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"

export type SummarizationModeInterop = AgentMode
export type SummarizationHookArgsInterop = InstanceType<typeof ExecuteHookArgs>
export type SummarizationHookResultInterop = ExecuteHookResult
export const defaultSummarizationModeInterop = AgentMode.AGENT

export function createPreCompactHookArgsInterop(input: {
  readonly trigger: "manual" | "auto"
  readonly contextUsagePercent: number
  readonly contextTokens: number
  readonly contextWindowSize: number
  readonly messageCount: number
  readonly messagesToCompact: number
  readonly isFirstCompaction: boolean
  readonly conversationId: string
  readonly generationId: string
  readonly model: string
}): SummarizationHookArgsInterop {
  return new ExecuteHookArgs({
    request: new ExecuteHookRequest({
      request: {
        case: "preCompact",
        value: new PreCompactRequestQuery({
          trigger: input.trigger,
          contextUsagePercent: input.contextUsagePercent,
          contextTokens: BigInt(input.contextTokens),
          contextWindowSize: BigInt(input.contextWindowSize),
          messageCount: input.messageCount,
          messagesToCompact: input.messagesToCompact,
          isFirstCompaction: input.isFirstCompaction,
          conversationId: input.conversationId,
          generationId: input.generationId,
          model: input.model,
        }),
      },
    }),
  })
}

export function preCompactHookUserMessageInterop(
  result: SummarizationHookResultInterop,
): string | undefined {
  return result.response?.response.case === "preCompact"
    ? result.response.response.value.userMessage || undefined
    : undefined
}

export function createSummaryCompletedUpdateInterop(
  update: unknown,
  privacyMode: PrivacyMode,
): unknown {
  return toRedactedInteractionUpdate(update as never, privacyMode)
}
