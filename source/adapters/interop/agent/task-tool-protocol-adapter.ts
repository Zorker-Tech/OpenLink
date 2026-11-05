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
export { createTaskUserMessageActionInterop } from "./task-runtime-protocol-adapter.ts"
import {
  SlateTaskBackgroundReason,
  type SlateTaskBackgroundReason as SlateTaskBackgroundReasonValue,
  type SlateTaskResult,
} from "../../../packages/agent/tools/task-result-state.ts"
export {
  fromInteropTaskConversationState,
  fromRedactedTaskConversationState,
  normalizePreparedTaskConversationStateInterop,
} from "./task-conversation-state-adapter.ts"

export type TaskResultInterop = TaskResult
export { fromRedactedConversationStateStructureInterop }
export const toRedactedConversationActionInterop = toRedactedConversationAction
export const toRedactedConversationStateStructureInterop = toRedactedTaskConversationState

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
