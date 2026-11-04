import {
  TaskError,
  TaskResult,
  TaskToolCall,
  TaskToolCallDelta,
  ToolCall,
  ToolCallDelta,
} from "../proto/generated/agent/v1/agent_pb.ts"
import { SubagentArgs } from "../proto/generated/agent/v1/subagent_exec_pb.ts"
import {
  fromRedactedConversationStateStructure,
  toRedactedConversationAction,
  toRedactedConversationStateStructure,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"

export type TaskResultInterop = TaskResult
export type TaskSubagentCredentialsInterop = SubagentArgs["credentials"]
export const fromRedactedConversationStateStructureInterop = fromRedactedConversationStateStructure
export const toRedactedConversationActionInterop = toRedactedConversationAction
export const toRedactedConversationStateStructureInterop = toRedactedConversationStateStructure

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
