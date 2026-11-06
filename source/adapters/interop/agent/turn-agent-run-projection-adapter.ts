/** Convert the host's turn selection into the redacted Agent input required by the interop boundary. */

import { toRedactedConversationAction } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { ConversationAction, ConversationStateStructure } from "../proto/generated/agent/v1/agent_pb.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { toRedactedConversationStateStructureInterop } from "./agent-state-message-serdes-adapter.ts"

export {
  restoreAgentConversationState,
  restoreSlateConversationState,
} from "./redacted-conversation-state-adapter.ts"

export type InteropConversationAction = ConversationAction
export type InteropConversationState = ConversationStateStructure

export interface RedactedAgentAction {
  readonly _privacyMode: PrivacyMode
  readonly triggeringAuthId?: string | undefined
  readonly triggeringUserInfo?: Readonly<Record<string, unknown>> | undefined
  readonly requestContextParts?: Readonly<Record<string, unknown>> | undefined
  readonly action: { readonly case: string | undefined; readonly value?: Readonly<Record<string, unknown>> | undefined }
}

export interface RedactedAgentConversationState {
  readonly _privacyMode: PrivacyMode
  readonly rootPromptMessagesJson: readonly Uint8Array[]
  readonly turns: readonly Uint8Array[]
  readonly todos: readonly Uint8Array[]
  readonly pendingToolCalls: readonly RedactedString[]
  readonly previousWorkspaceUris: readonly RedactedString[]
  readonly summaryArchives: readonly Uint8Array[]
  readonly turnTimings: readonly Readonly<Record<string, unknown>>[]
  readonly readPaths: readonly RedactedString[]
  readonly [field: string]: unknown
}

export interface InteropTurnRunProjection {
  readonly state: RedactedAgentConversationState
  readonly action: RedactedAgentAction
  readonly isResume: boolean
}

export function cloneInteropConversationState(state: InteropConversationState): InteropConversationState {
  return ConversationStateStructure.fromBinary(state.toBinary())
}

export function projectInteropTurnRun(input: {
  readonly baseState: InteropConversationState
  readonly action: InteropConversationAction
  readonly resumeFrom?: InteropConversationState
  readonly resumeAction: InteropConversationAction
  readonly privacyMode: PrivacyMode
}): InteropTurnRunProjection {
  const isResume = input.resumeFrom !== undefined
  return {
    state: toRedactedConversationStateStructureInterop(input.resumeFrom ?? input.baseState, input.privacyMode),
    action: toRedactedConversationAction(isResume ? input.resumeAction : input.action, input.privacyMode),
    isResume,
  }
}
