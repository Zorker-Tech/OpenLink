import {
  SubagentPersistedState,
  TaskError,
  TaskResult,
  TaskToolCall,
  ToolCall,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  ForceBackgroundSubagentArgs,
  ForceBackgroundSubagentStatus,
} from "../proto/generated/agent/v1/subagent_exec_pb.ts"
import { fromRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import { isSlateSelectedContextState } from "../../../packages/agent/context/selected-context-state.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import type { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { SlateConversationStep } from "../../../packages/agent/conversation-step-state.ts"
import {
  createSlateTaskSuccessResult,
  SlateTaskBackgroundReason,
  type SlateTaskResult,
} from "../../../packages/agent/tools/task-result-state.ts"
import { forceBackgroundSubagentExecutorResource } from "./subagent-control-exec-adapter.ts"
import { slateSubagentExecutorResource } from "../../../packages/agent-exec/subagent.ts"
import type {
  SlateTaskClientContinuationConfig,
  SlateTaskClientSubagentRequest,
  SlateTaskClientSubagentRunView,
} from "../../../packages/agent/tools/task-client-contracts.ts"

export type TaskClientContinuationConfigInput = SlateTaskClientContinuationConfig
export type TaskClientSubagentRequest = SlateTaskClientSubagentRequest
export type TaskClientSubagentRunView = SlateTaskClientSubagentRunView

export function createTaskToolCallInterop(value: unknown): unknown {
  return new ToolCall({ tool: { case: "taskToolCall", value: value as TaskToolCall } })
}

export function createSerializedTaskToolCallErrorInterop(error: string): unknown {
  return createTaskToolCallInterop(new TaskToolCall({
    result: new TaskResult({ result: { case: "error", value: new TaskError({ error }) } }),
  }))
}

export function createSlateTaskClientContinuationConfig(
  input: TaskClientContinuationConfigInput,
): SlateTaskClientContinuationConfig {
  return { ...input }
}

export function getVideoPathsFromRedactedSelectedContextInterop(
  selectedContext: unknown,
  capability: PrivacyCapability,
): string[] {
  if (isSlateSelectedContextState(selectedContext)) {
    return selectedContext.media.videos.map(video =>
      video.path instanceof RedactedString ? video.path.unwrap(capability) : video.path,
    )
  }
  const context = fromRedactedSelectedContext(selectedContext, capability, {})
  return context.selectedVideos.map(({ path }) => path)
}

export function requestSubagentBackgroundHandoffInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  toolCallId: string,
): Promise<boolean> {
  const executor = resourceAccessor.get(forceBackgroundSubagentExecutorResource)
  return executor.execute(ctx, new ForceBackgroundSubagentArgs({ toolCallId }))
    .then((result) => result.status === ForceBackgroundSubagentStatus.ACCEPTED)
}

export function isCloudSubagentEnvironment(environment: unknown): boolean {
  return environment === "cloud"
}

export function createLocalSubagentPersistedStateInterop(modelId: string): unknown {
  return new SubagentPersistedState({ modelId })
}

export function createSlateTaskClientSuccessResult(input: {
  readonly run: Extract<TaskClientSubagentRunView, { readonly kind: "success" }>
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

export async function runClientSubagent(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  request: TaskClientSubagentRequest,
): Promise<TaskClientSubagentRunView> {
  const result = await resourceAccessor.get(slateSubagentExecutorResource).execute(ctx, request)
  if (result.status === "error") return { kind: "error", error: result.error }
  return {
    kind: "success",
    agentId: result.agentId,
    ...(result.finalMessage === undefined ? {} : { finalMessage: result.finalMessage }),
    backgroundReason: result.backgroundReason ?? SlateTaskBackgroundReason.UNSPECIFIED,
    ...(result.transcriptPath === undefined ? {} : { transcriptPath: result.transcriptPath }),
  }
}
