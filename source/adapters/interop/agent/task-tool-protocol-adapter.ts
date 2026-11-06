import {
  SubagentBackgroundReason,
  TaskError,
  TaskResult,
  TaskSuccess,
  TaskToolCall,
  TaskToolCallDelta,
  ToolCall,
  ToolCallDelta,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  toRedactedConversationAction,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { toRedactedTaskConversationState } from "./task-conversation-state-adapter.ts"
import {
  fromRedactedConversationStateStructureInterop,
  fromInteropConversationStep,
  toPlainInteropConversationStep,
} from "./agent-state-message-serdes-adapter.ts"
import { slateAgentActionFromInterop } from "./turn-agent-run-projection-adapter.ts"
export { createTaskUserMessageActionInterop } from "./task-runtime-protocol-adapter.ts"
import {
  SlateTaskBackgroundReason,
  type SlateTaskBackgroundReason as SlateTaskBackgroundReasonValue,
  type SlateTaskResult,
} from "../../../packages/agent/tools/task-result-state.ts"
import type { SlateTaskRequest, TaskTargetMachine } from "../../../packages/agent/tools/task-runtime-types.ts"
export {
  fromInteropTaskConversationState,
  fromRedactedTaskConversationState,
  normalizePreparedTaskConversationStateInterop,
} from "./task-conversation-state-adapter.ts"

export type TaskResultInterop = TaskResult
export { fromRedactedConversationStateStructureInterop }
export { slateAgentActionFromInterop }
export const toRedactedConversationActionInterop = toRedactedConversationAction
export const toRedactedConversationStateStructureInterop = toRedactedTaskConversationState

function slateTargetMachineFromModelArgumentsInterop(value: unknown): TaskTargetMachine | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const machine = value as Record<string, unknown>
  if (typeof machine.kind === "string") {
    switch (machine.kind) {
      case "same-device":
        return { kind: "same-device" }
      case "cloud-machine":
        return {
          kind: "cloud-machine",
          ...(typeof machine.baseBranch === "string" ? { baseBranch: machine.baseBranch } : {}),
          ...(typeof machine.environmentBuildId === "string" ? { environmentBuildId: machine.environmentBuildId } : {}),
        }
      case "hosted-worker":
        return typeof machine.workerId === "string" && machine.workerId.length > 0
          ? { kind: "hosted-worker", workerId: machine.workerId }
          : undefined
      case "worker-pool": {
        const labels = machine.labels
        const clonedLabels = labels !== null && typeof labels === "object" && !Array.isArray(labels)
          ? Object.fromEntries(Object.entries(labels)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
          : undefined
        return {
          kind: "worker-pool",
          ...(typeof machine.pool === "string" ? { pool: machine.pool } : {}),
          ...(clonedLabels === undefined ? {} : { labels: clonedLabels }),
        }
      }
      default:
        return undefined
    }
  }

  switch (machine.type) {
    case "same_machine":
      return { kind: "same-device" }
    case "new_cloud_vm":
      return {
        kind: "cloud-machine",
        ...(typeof machine.base_branch === "string" ? { baseBranch: machine.base_branch } : {}),
        ...(typeof machine.environment_build_id === "string" ? { environmentBuildId: machine.environment_build_id } : {}),
      }
    case "self_hosted_worker":
      return typeof machine.worker_id === "string" && machine.worker_id.length > 0
        ? { kind: "hosted-worker", workerId: machine.worker_id }
        : undefined
    case "self_hosted_pool": {
      const labels = machine.labels
      const clonedLabels = labels !== null && typeof labels === "object" && !Array.isArray(labels)
        ? Object.fromEntries(Object.entries(labels)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
        : undefined
      return {
        kind: "worker-pool",
        ...(typeof machine.pool === "string" ? { pool: machine.pool } : {}),
        ...(clonedLabels === undefined ? {} : { labels: clonedLabels }),
      }
    }
    default:
      return undefined
  }
}

function aliasedValue(input: Record<string, unknown>, current: string, previous: string): unknown {
  const currentValue = input[current]
  const previousValue = input[previous]
  if (currentValue !== undefined && previousValue !== undefined) {
    throw new TypeError(`Task tool input cannot contain both ${current} and legacy ${previous}`)
  }
  return currentValue !== undefined ? currentValue : previousValue
}

/** Converts the Slate model-call contract or a previous prompt dialect into Slate's task request. */
export function slateTaskRequestFromModelArgumentsInterop(
  value: unknown,
  options: { readonly defaultSubagentTypeName?: string } = {},
): SlateTaskRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Task tool input must be an object")
  }
  const input = value as Record<string, unknown>
  if (typeof input.prompt !== "string") throw new TypeError("Task tool prompt must be a string")
  const subagentType = aliasedValue(input, "subagentType", "subagent_type")
  const fileAttachments = aliasedValue(input, "fileAttachments", "file_attachments")
  const targetMachineValue = aliasedValue(input, "targetMachine", "machine")
  const cloudBaseBranch = aliasedValue(input, "cloudBaseBranch", "cloud_base_branch")
  const requestedRuntimeBuildId = aliasedValue(input, "requestedRuntimeBuildId", "cloud_requested_environment_build_id")
  const runInBackground = aliasedValue(input, "runInBackground", "run_in_background")
  const targetMachine = slateTargetMachineFromModelArgumentsInterop(targetMachineValue)
  return {
    prompt: input.prompt,
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.resume === "string" ? { resume: input.resume } : {}),
    ...(typeof subagentType === "string"
      ? { subagentType }
      : options.defaultSubagentTypeName === undefined ? {} : { subagentType: options.defaultSubagentTypeName }),
    ...(Array.isArray(fileAttachments)
      ? { fileAttachments: (fileAttachments as string[]).slice() }
      : {}),
    ...(input.environment === "cloud" || input.environment === "local"
      ? { environment: input.environment }
      : {}),
    ...(typeof cloudBaseBranch === "string" ? { cloudBaseBranch } : {}),
    ...(typeof requestedRuntimeBuildId === "string"
      ? { requestedRuntimeBuildId }
      : {}),
    ...(targetMachine === undefined ? {} : { targetMachine }),
    ...(typeof runInBackground === "boolean" ? { runInBackground } : {}),
    ...(typeof input.interrupt === "boolean" ? { interrupt: input.interrupt } : {}),
  }
}

function backgroundReasonFromInterop(value: unknown): SlateTaskBackgroundReasonValue {
  switch (value) {
    case SubagentBackgroundReason.AGENT_REQUEST: return SlateTaskBackgroundReason.AGENT_REQUEST
    case SubagentBackgroundReason.USER_REQUEST: return SlateTaskBackgroundReason.USER_REQUEST
    case SubagentBackgroundReason.QUEUED_FOLLOW_UP: return SlateTaskBackgroundReason.QUEUED_FOLLOW_UP
    case SubagentBackgroundReason.UNSPECIFIED: return SlateTaskBackgroundReason.UNSPECIFIED
    default: return typeof value === "number" && Number.isInteger(value)
      ? `unknown-${value}`
      : SlateTaskBackgroundReason.UNKNOWN
  }
}

function backgroundReasonToInterop(value: SlateTaskBackgroundReasonValue): SubagentBackgroundReason {
  switch (value) {
    case SlateTaskBackgroundReason.AGENT_REQUEST: return SubagentBackgroundReason.AGENT_REQUEST
    case SlateTaskBackgroundReason.USER_REQUEST: return SubagentBackgroundReason.USER_REQUEST
    case SlateTaskBackgroundReason.QUEUED_FOLLOW_UP: return SubagentBackgroundReason.QUEUED_FOLLOW_UP
    case SlateTaskBackgroundReason.UNSPECIFIED:
    case SlateTaskBackgroundReason.UNKNOWN:
      return SubagentBackgroundReason.UNSPECIFIED
    default: {
      const unknown = /^unknown-(-?\d+)$/.exec(value)
      return unknown === null ? SubagentBackgroundReason.UNSPECIFIED : Number(unknown[1]) as SubagentBackgroundReason
    }
  }
}

/** Projects the Slate task result into the generated message required by the current tool executor. */
export function toInteropTaskResultInterop(value: SlateTaskResult): TaskResultInterop {
  if (value.kind === "error") {
    return new TaskResult({ result: { case: "error", value: new TaskError({ error: value.message }) } })
  }
  if (value.kind === "unknown") return new TaskResult()
  return new TaskResult({
    result: {
      case: "success",
      value: new TaskSuccess({
        conversationSteps: value.conversationSteps.map(toPlainInteropConversationStep),
        ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
        isBackground: value.isBackground,
        ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
        ...(value.resultSuffix === undefined ? {} : { resultSuffix: value.resultSuffix }),
        backgroundReason: backgroundReasonToInterop(value.backgroundReason),
        ...(value.transcriptUri === undefined ? {} : { transcriptPath: value.transcriptUri }),
      }),
    },
  })
}

/** Imports the tool executor's message into Slate before task result policy or rendering reads it. */
export function fromInteropTaskResultInterop(value: TaskResultInterop): SlateTaskResult {
  switch (value.result.case) {
    case "error":
      return { kind: "error", message: value.result.value.error }
    case "success":
      return {
        kind: "success",
        conversationSteps: value.result.value.conversationSteps.map(step => fromInteropConversationStep(step)),
        ...(value.result.value.agentId === undefined ? {} : { agentId: value.result.value.agentId }),
        isBackground: value.result.value.isBackground,
        ...(value.result.value.durationMs === undefined ? {} : { durationMs: value.result.value.durationMs }),
        ...(value.result.value.resultSuffix === undefined ? {} : { resultSuffix: value.result.value.resultSuffix }),
        backgroundReason: backgroundReasonFromInterop(value.result.value.backgroundReason),
        ...(value.result.value.transcriptPath === undefined ? {} : { transcriptUri: value.result.value.transcriptPath }),
      }
    default:
      return { kind: "unknown" }
  }
}

export function createTaskToolCallInterop(): ToolCall {
  return new ToolCall({ tool: { case: "taskToolCall", value: new TaskToolCall() } })
}

export function serializeTaskErrorInterop(error: unknown): ToolCall {
  const message = error instanceof Error ? error.message : String(error)
  const taskResult = new TaskResult({ result: { case: "error", value: new TaskError({ error: message }) } })
  return new ToolCall({
    tool: {
      case: "taskToolCall",
      value: new TaskToolCall({ result: taskResult }),
    },
  })
}

export function createTaskToolCallDeltaInterop(update: unknown): ToolCallDelta {
  return new ToolCallDelta({
    delta: {
      case: "taskToolCallDelta",
      value: new TaskToolCallDelta({ interactionUpdate: update as never }),
    },
  })
}
