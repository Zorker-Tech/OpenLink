import {
  AgentMode,
  ConversationAction,
  SubagentPersistedState,
  TaskResult,
  TaskSuccess,
  UserMessage,
  UserMessageAction,
  type ConversationStateStructure,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts"

/** Builds the counterpart action envelope for a Slate-owned follow-up decision. */
export function createTaskSubagentFollowupActionInterop(input: {
  readonly text: string
  readonly messageId: string
  readonly useAskMode: boolean
  readonly selectedContext?: unknown
}): unknown {
  return new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({
        userMessage: new UserMessage({
          text: input.text,
          messageId: input.messageId,
          mode: input.useAskMode ? AgentMode.ASK : AgentMode.AGENT,
          ...(input.selectedContext !== undefined
            ? { selectedContext: input.selectedContext as SelectedContext }
            : {}),
        }),
      }),
    },
  })
}

/** Builds the counterpart result envelope after Slate has collected its own completion data. */
export function createTaskSubagentSuccessResultInterop(input: {
  readonly agentId: string
  readonly conversationSteps: readonly unknown[]
  readonly durationMs: number
  readonly resultSuffix?: string
}): unknown {
  return new TaskResult({
    result: {
      case: "success",
      value: new TaskSuccess({
        conversationSteps: input.conversationSteps as TaskSuccess["conversationSteps"],
        agentId: input.agentId,
        durationMs: BigInt(input.durationMs),
        ...(input.resultSuffix !== undefined ? { resultSuffix: input.resultSuffix } : {}),
      }),
    },
  })
}

/** Wraps the opaque runner state in the counterpart persistence message at the service boundary. */
export function createTaskSubagentPersistedStateInterop(input: {
  readonly conversationState: unknown
  readonly modelId: string
}): unknown {
  return new SubagentPersistedState({
    conversationState: input.conversationState as ConversationStateStructure,
    modelId: input.modelId,
  })
}
