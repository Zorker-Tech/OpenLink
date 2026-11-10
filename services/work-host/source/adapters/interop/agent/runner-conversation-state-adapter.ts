/** Validate and copy a generated Agent checkpoint before the host stores or returns it. */

import { ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"

export type InteropRunnerConversationState = ConversationStateStructure

export function cloneInteropRunnerConversationState(value: unknown): InteropRunnerConversationState | undefined {
  if (typeof value !== "object" || value === null || !("toBinary" in value) || typeof value.toBinary !== "function") {
    return undefined
  }
  return ConversationStateStructure.fromBinary(value.toBinary())
}
