import type { Context } from "../../context/context.ts"
import type { RemoteExecManager } from "../../agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../agent-exec/resource-provider.ts"
import { slateSubagentExecutorResource } from "../../agent-exec/subagent.ts"
import { slateSubagentBackgroundHandoffExecutorResource } from "../../agent-exec/subagent-control.ts"
import {
  createSlateTaskSuccessResult,
  SlateTaskBackgroundReason,
  type SlateTaskResult,
} from "./task-result-state.ts"
import type {
  SlateTaskClientContinuationConfig,
  SlateTaskClientSubagentRequest,
  SlateTaskClientSubagentRunView,
} from "./task-client-contracts.ts"
import type { SlateConversationStep } from "../conversation-step-state.ts"

export function createSlateTaskClientContinuationConfig(
  input: SlateTaskClientContinuationConfig,
): SlateTaskClientContinuationConfig {
  return { ...input }
}

export async function requestSlateSubagentBackgroundHandoff(
  context: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  toolCallId: string,
): Promise<boolean> {
  const result = await resourceAccessor.get(slateSubagentBackgroundHandoffExecutorResource)
    .execute(context, { toolCallId })
  return result.status === "accepted"
}

export async function runClientSubagent(
  context: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  request: SlateTaskClientSubagentRequest,
): Promise<SlateTaskClientSubagentRunView> {
  const result = await resourceAccessor.get(slateSubagentExecutorResource).execute(context, request)
  if (result.status === "error") return { kind: "error", error: result.error }
  return {
    kind: "success",
    agentId: result.agentId,
    ...(result.finalMessage === undefined ? {} : { finalMessage: result.finalMessage }),
    backgroundReason: result.backgroundReason ?? SlateTaskBackgroundReason.UNSPECIFIED,
    ...(result.transcriptPath === undefined ? {} : { transcriptPath: result.transcriptPath }),
  }
}

export function createSlateTaskClientSuccessResult(input: {
  readonly run: Extract<SlateTaskClientSubagentRunView, { readonly kind: "success" }>
  readonly conversationSteps: readonly SlateConversationStep[]
  readonly durationMs: number
  readonly agentId?: string
  readonly isBackground: boolean
}): SlateTaskResult {
  return createSlateTaskSuccessResult({
    conversationSteps: input.conversationSteps,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    isBackground: input.isBackground,
    durationMs: BigInt(input.durationMs),
    backgroundReason: input.run.backgroundReason,
    ...(input.run.transcriptPath === undefined ? {} : { transcriptUri: input.run.transcriptPath }),
  })
}
