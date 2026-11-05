import {
  AgentMode,
  ConversationAction,
  SubagentPersistedState,
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
