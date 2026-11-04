/** Restore a saved Agent conversation state for the checkpoint update boundary. */

import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { fromRedactedConversationStateStructure } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"

export function restoreAgentConversationState(state: unknown): unknown {
  return fromRedactedConversationStateStructure(
    state as never,
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
}
