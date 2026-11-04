import { ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"
import { fromRedactedConversationStateStructure } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { SlateTaskConversationState } from "../../../packages/agent/subagent-persisted-state.ts"

/** Projects the external top-level snapshot into Slate's own launch/resume value. */
export function fromInteropTaskConversationState(
  value: ConversationStateStructure,
): SlateTaskConversationState {
  return {
    ...(value as unknown as Record<string, unknown>),
    turns: [...value.turns],
  } as SlateTaskConversationState
}

/**
 * Reconstructs the generated message only where the subagent protocol requires it.
 *
 * Nested values remain the external message objects the owning conversation codec produced; rebuilding the
 * outer message validates the top-level shape without changing any persisted field.
 */
export function toInteropTaskConversationState(
  value: SlateTaskConversationState,
): ConversationStateStructure {
  return new ConversationStateStructure(value as never)
}

export function fromRedactedTaskConversationState(
  value: Parameters<typeof fromRedactedConversationStateStructure>[0],
): SlateTaskConversationState {
  return fromInteropTaskConversationState(
    fromRedactedConversationStateStructure(
      value,
      PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
      undefined,
    ),
  )
}
