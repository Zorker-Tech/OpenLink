import {
  TaskError,
  TaskResult,
  TaskToolCall,
  TaskToolCallDelta,
  ToolCall,
  ToolCallDelta,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  toRedactedConversationAction,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { toRedactedTaskConversationState } from "./task-conversation-state-adapter.ts"
export { createTaskInitialUserActionInterop } from "./task-runtime-protocol-adapter.ts"
import { fromRedactedConversationStateStructureInterop } from "./agent-state-message-serdes-adapter.ts"
export {
  fromInteropTaskConversationState,
  fromRedactedTaskConversationState,
  normalizePreparedTaskConversationStateInterop,
} from "./task-conversation-state-adapter.ts"

export type TaskResultInterop = TaskResult
export { fromRedactedConversationStateStructureInterop }
export const toRedactedConversationActionInterop = toRedactedConversationAction
export const toRedactedConversationStateStructureInterop = toRedactedTaskConversationState

export function createTaskErrorResultInterop(error: unknown): TaskResultInterop {
  const message = error instanceof Error ? error.message : String(error)
  return new TaskResult({ result: { case: "error", value: new TaskError({ error: message }) } })
}

export function createMissingSubagentResultInterop(): TaskResultInterop {
  return new TaskResult({
    result: {
      case: "error",
      value: new TaskError({ error: "Subagent completed without a result" }),
    },
  })
}

export function createTaskToolCallInterop(): ToolCall {
  return new ToolCall({ tool: { case: "taskToolCall", value: new TaskToolCall() } })
}

export function serializeTaskErrorInterop(error: unknown): ToolCall {
  const taskResult = createTaskErrorResultInterop(error)
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

export function taskResultIsErrorInterop(result: TaskResultInterop): boolean {
  return result.result.case === "error"
}
