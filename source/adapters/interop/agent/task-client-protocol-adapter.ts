import {
  SubagentBackgroundReason,
  SubagentExecutionEnvironment,
  SubagentPersistedState,
  TaskError,
  TaskResult,
  TaskToolCall,
  ToolCall,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  ClientContinuationConfig,
  ForceBackgroundSubagentArgs,
  ForceBackgroundSubagentStatus,
  SubagentArgs,
  type SubagentResult,
} from "../proto/generated/agent/v1/subagent_exec_pb.ts"
import { fromRedactedSelectedContext } from "../redacted-protos/generated/agent/v1/selected_context_redacted.ts"
import type { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { Context } from "../../../packages/context/context.ts"
import type { RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts"
import type { ResourceAccessor } from "../../../packages/agent-exec/resource-provider.ts"
import type { TaskEnvironment } from "../../../packages/agent/tools/task-runtime-types.ts"
import type { SlateConversationStep } from "../../../packages/agent/conversation-step-state.ts"
import {
  createSlateTaskSuccessResult,
  SlateTaskBackgroundReason,
  type SlateTaskResult,
  type SlateTaskBackgroundReason as SlateTaskBackgroundReasonValue,
} from "../../../packages/agent/tools/task-result-state.ts"
import { forceBackgroundSubagentExecutorResource } from "./subagent-control-exec-adapter.ts"
import { subagentExecutorResource } from "./subagent-exec-adapter.ts"
import { taskEnvironmentToProtoInterop } from "./task-runtime-protocol-adapter.ts"

export type TaskClientBackgroundReason = "unspecified" | "agent_request" | "user_request" | "queued_follow_up" | "unknown"

export interface TaskClientContinuationConfigInput {
  readonly idleThreshold: number
  readonly maxLoops: number
  readonly nudgeMessage: string
  readonly escapeMessageTemplate: string
  readonly collectBackgroundChildren: boolean
  readonly childrenCompletedMessageTemplate: string
}

export interface TaskClientSubagentRequest {
  readonly toolCallId: string
  readonly subagentType: string
  readonly modelId: string
  readonly prompt: string
  readonly readonly: boolean
  readonly resumeAgentId?: string
  readonly forkAgentId?: string
  readonly interrupt?: boolean
  readonly runInBackground?: boolean
  readonly continuationConfig?: unknown
  readonly rootParentConversationId?: string
  readonly parentConversationId?: string
  readonly selectedContext?: unknown
  readonly environment: TaskEnvironment
  readonly cloudBaseBranch?: string
  readonly modelParameters?: readonly { readonly id: string; readonly value: string }[]
  readonly credentials?: unknown
}

export type TaskClientSubagentRunView =
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "success"
      readonly agentId?: string
      readonly finalMessage?: string
      readonly backgroundReason: TaskClientBackgroundReason
      readonly backgroundReasonInterop?: unknown
      readonly transcriptPath?: string
    }
  | { readonly kind: "unknown" }

export function normalizeTaskClientBackgroundReasonInterop(value: unknown): TaskClientBackgroundReason {
  switch (value) {
    case "unspecified":
    case "agent_request":
    case "user_request":
    case "queued_follow_up":
    case "unknown":
      return value
    case SubagentBackgroundReason.UNSPECIFIED:
      return "unspecified"
    case SubagentBackgroundReason.AGENT_REQUEST:
      return "agent_request"
    case SubagentBackgroundReason.USER_REQUEST:
      return "user_request"
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP:
      return "queued_follow_up"
    default:
      return "unknown"
  }
}

function backgroundReasonToInterop(value: TaskClientBackgroundReason): SubagentBackgroundReason {
  switch (value) {
    case "agent_request":
      return SubagentBackgroundReason.AGENT_REQUEST
    case "user_request":
      return SubagentBackgroundReason.USER_REQUEST
    case "queued_follow_up":
      return SubagentBackgroundReason.QUEUED_FOLLOW_UP
    case "unspecified":
    case "unknown":
      return SubagentBackgroundReason.UNSPECIFIED
  }
}

export function createTaskToolCallInterop(value: unknown): unknown {
  return new ToolCall({ tool: { case: "taskToolCall", value: value as TaskToolCall } })
}

export function createSerializedTaskToolCallErrorInterop(error: string): unknown {
  return createTaskToolCallInterop(new TaskToolCall({
    result: new TaskResult({ result: { case: "error", value: new TaskError({ error }) } }),
  }))
}

export function createTaskClientContinuationConfigInterop(input: TaskClientContinuationConfigInput): unknown {
  return new ClientContinuationConfig(input)
}

export function getVideoPathsFromRedactedSelectedContextInterop(
  selectedContext: unknown,
  capability: PrivacyCapability,
): string[] {
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

export function isCloudSubagentEnvironmentInterop(environment: unknown): boolean {
  return environment === SubagentExecutionEnvironment.CLOUD
}

export function createLocalSubagentPersistedStateInterop(modelId: string): unknown {
  return new SubagentPersistedState({ modelId })
}

export function createSlateTaskClientSuccessResultInterop(input: {
  readonly run: Extract<TaskClientSubagentRunView, { readonly kind: "success" }>
  readonly conversationSteps: readonly SlateConversationStep[]
  readonly durationMs: number
  readonly agentId?: string
  readonly isBackground: boolean
}): SlateTaskResult {
  const backgroundReason = input.run.backgroundReasonInterop as SubagentBackgroundReason | undefined
    ?? backgroundReasonToInterop(input.run.backgroundReason)
  const slateBackgroundReason: SlateTaskBackgroundReasonValue = backgroundReason === SubagentBackgroundReason.AGENT_REQUEST
    ? SlateTaskBackgroundReason.AGENT_REQUEST
    : backgroundReason === SubagentBackgroundReason.USER_REQUEST
      ? SlateTaskBackgroundReason.USER_REQUEST
      : backgroundReason === SubagentBackgroundReason.QUEUED_FOLLOW_UP
        ? SlateTaskBackgroundReason.QUEUED_FOLLOW_UP
        : backgroundReason === SubagentBackgroundReason.UNSPECIFIED
          ? SlateTaskBackgroundReason.UNSPECIFIED
          : typeof backgroundReason === "number" && Number.isInteger(backgroundReason)
            ? `unknown-${backgroundReason}`
            : SlateTaskBackgroundReason.UNKNOWN
  return createSlateTaskSuccessResult({
    conversationSteps: input.conversationSteps,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    isBackground: input.isBackground,
    durationMs: BigInt(input.durationMs),
    backgroundReason: slateBackgroundReason,
    ...(input.run.transcriptPath === undefined ? {} : { transcriptUri: input.run.transcriptPath }),
  })
}

export async function runClientSubagentInterop(
  ctx: Context,
  resourceAccessor: ResourceAccessor<RemoteExecManager>,
  request: TaskClientSubagentRequest,
): Promise<TaskClientSubagentRunView> {
  const executor = resourceAccessor.get(subagentExecutorResource)
  const result: SubagentResult = await executor.execute(ctx, new SubagentArgs({
    toolCallId: request.toolCallId,
    subagentType: request.subagentType,
    modelId: request.modelId,
    prompt: request.prompt,
    readonly: request.readonly,
    ...(request.resumeAgentId === undefined ? {} : { resumeAgentId: request.resumeAgentId }),
    ...(request.forkAgentId === undefined ? {} : { forkAgentId: request.forkAgentId }),
    ...(request.interrupt === undefined ? {} : { interrupt: request.interrupt }),
    ...(request.runInBackground === undefined ? {} : { runInBackground: request.runInBackground }),
    ...(request.continuationConfig === undefined ? {} : { continuationConfig: request.continuationConfig as ClientContinuationConfig }),
    ...(request.rootParentConversationId === undefined ? {} : { rootParentConversationId: request.rootParentConversationId }),
    ...(request.parentConversationId === undefined ? {} : { parentConversationId: request.parentConversationId }),
    ...(request.selectedContext === undefined ? {} : { selectedContext: request.selectedContext as NonNullable<SubagentArgs["selectedContext"]> }),
    environment: taskEnvironmentToProtoInterop(request.environment),
    ...(request.cloudBaseBranch === undefined ? {} : { cloudBaseBranch: request.cloudBaseBranch }),
    ...(request.modelParameters === undefined ? {} : { modelParameters: [...request.modelParameters] }),
    ...(request.credentials === undefined ? {} : { credentials: request.credentials as SubagentArgs["credentials"] }),
  }))
  const resultValue = result.result
  if (resultValue.case === "error") {
    return { kind: "error", error: resultValue.value.error ?? "" }
  }
  if (resultValue.case !== "success") return { kind: "unknown" }
  const success = resultValue.value
  return {
    kind: "success",
    ...(success.agentId === undefined ? {} : { agentId: success.agentId }),
    ...(success.finalMessage === undefined ? {} : { finalMessage: success.finalMessage }),
    backgroundReason: normalizeTaskClientBackgroundReasonInterop(success.backgroundReason),
    backgroundReasonInterop: success.backgroundReason,
    ...(success.transcriptPath === undefined ? {} : { transcriptPath: success.transcriptPath }),
  }
}
