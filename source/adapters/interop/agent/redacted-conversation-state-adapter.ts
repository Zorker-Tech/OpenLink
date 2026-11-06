/** Project a Slate conversation snapshot into the runner's legacy checkpoint message. */

import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { SlateConversationState } from "../../../packages/agent/conversation-state.ts"
import {
  fromRedactedConversationStateStructureInterop,
  toInteropConversationState,
  type RedactedAgentConversationStateInterop,
} from "./agent-state-message-serdes-adapter.ts"

export type RunnerConversationState = ReturnType<typeof fromRedactedConversationStateStructureInterop>

export function redactAgentConversationState(state: SlateConversationState): RedactedAgentConversationStateInterop {
  return toInteropConversationState(state)
}

export function restoreAgentConversationState(state: SlateConversationState): RunnerConversationState {
  return fromRedactedConversationStateStructureInterop(
    redactAgentConversationState(state),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
}
