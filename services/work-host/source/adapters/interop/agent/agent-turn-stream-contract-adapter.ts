/** Historical serialized state/action types accepted by the Agent stream migration boundary. */

import type {
  ConversationAction,
  ConversationStateStructure,
} from "../proto/generated/agent/v1/agent_pb.ts"

export type AgentConversationAction = ConversationAction
export type AgentConversationState = ConversationStateStructure
