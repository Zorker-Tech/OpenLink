import { ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../../../packages/redaction/privacy-mode.ts"
import type { SlateTaskConversationState } from "../../../packages/agent/subagent-persisted-state.ts"
import {
  fromRedactedConversationStateStructureInterop,
  fromInteropConversationState,
  toInteropConversationState,
  toRedactedConversationStateStructureInterop,
} from "./agent-state-message-serdes-adapter.ts"

function ownTaskSnapshot(
  value: SlateTaskConversationState,
  modeWasPersisted: boolean,
): SlateTaskConversationState {
  const snapshot: SlateTaskConversationState = {
    ...value,
    turns: value.turns.map(turn => new Uint8Array(turn)),
  }
  if (modeWasPersisted) return snapshot
  const { mode: _mode, ...withoutMode } = snapshot
  return withoutMode
}

/** Projects every conversation snapshot field into the Slate conversation model. */
export function fromInteropTaskConversationState(
  value: ConversationStateStructure,
  privacyMode: PrivacyModeValue = PrivacyMode.UNSPECIFIED,
): SlateTaskConversationState {
  return ownTaskSnapshot(
    fromInteropConversationState(toRedactedConversationStateStructureInterop(value, privacyMode)),
    value.mode !== undefined,
  )
}

/** Keeps the preparation-to-run privacy normalization while the enclosing task record stays Slate-owned. */
export function normalizePreparedTaskConversationStateInterop(
  value: SlateTaskConversationState,
  privacyMode: PrivacyModeValue,
): SlateTaskConversationState {
  return fromInteropTaskConversationState(toInteropTaskConversationState(value), privacyMode)
}

/** Reconstructs the historical message at the launch and persistence interop boundary. */
export function toInteropTaskConversationState(
  value: SlateTaskConversationState,
): ConversationStateStructure {
  return fromRedactedConversationStateStructureInterop(
    toInteropConversationState(value),
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
}

export function fromRedactedTaskConversationState(
  value: Parameters<typeof fromRedactedConversationStateStructureInterop>[0],
): SlateTaskConversationState {
  return ownTaskSnapshot(
    fromInteropConversationState(value as never),
    value.mode !== undefined,
  )
}

/** Builds the launch checkpoint from Slate state using the inherited conversation privacy mode. */
export function toRedactedTaskConversationState(
  value: SlateTaskConversationState,
  privacyMode: PrivacyModeValue,
) {
  return toInteropConversationState({ ...value, privacyMode })
}
