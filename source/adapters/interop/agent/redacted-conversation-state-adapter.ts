/** Project a Slate conversation snapshot into the runner's legacy checkpoint message. */

import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { SlateConversationState } from "../../../packages/agent/conversation-state.ts"
import {
  fromInteropConversationState,
  fromRedactedConversationStateStructureInterop,
  toInteropConversationState,
  type RedactedAgentConversationStateInterop,
} from "./agent-state-message-serdes-adapter.ts"

export type RunnerConversationState = ReturnType<typeof fromRedactedConversationStateStructureInterop>

/** Decode the runner's historical checkpoint shape at the host ingress boundary. */
export function restoreSlateConversationState(state: RedactedAgentConversationStateInterop): SlateConversationState {
  return fromInteropConversationState(state)
}

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
