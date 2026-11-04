/** Names for the generated state and action types used at the Agent stream boundary. */

import type {
  ConversationAction,
  ConversationStateStructure,
} from "../proto/generated/agent/v1/agent_pb.ts"

export type AgentConversationAction = ConversationAction
export type AgentConversationState = ConversationStateStructure
