/** Decodes redacted incoming message values before the host's turn policy handles them. */

import { slateModelCapabilitiesFromInterop } from "./model-capabilities-adapter.ts"
import { AgentMode, UserMessage } from "../proto/generated/agent/v1/agent_pb.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { fromRedactedUserMessage } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../../packages/agent/mode-processing.ts"
import { fromInteropUserMessage } from "./user-message-action-protocol-adapter.ts"
import { createSlateUserMessageInput, type SlateUserMessageInput } from "../../../packages/agent/user-message-state.ts"
import { isRedactedString } from "../../../packages/redaction/redacted-values.ts"

export function decodeIncomingUserMessage(value: unknown) {
  return fromRedactedUserMessage(value as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
}

export function decodeIncomingSlateUserMessage(value: unknown) {
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>
    const text = fields.text
    if (isRedactedString(text)) return fromInteropUserMessage(decodeIncomingUserMessage(value))
    if (value instanceof UserMessage || typeof fields.mode === "number") {
      return fromInteropUserMessage(value as UserMessage)
    }
    if (typeof text === "string" && (
      typeof fields.mode === "string" ||
      (fields.selectedContext !== null && typeof fields.selectedContext === "object" &&
        (fields.selectedContext as Record<string, unknown>).schema === "slate.selected-context") ||
      fields.conversationStateBlobId instanceof Uint8Array
    )) {
      return createSlateUserMessageInput(fields as unknown as SlateUserMessageInput)
    }
    if (typeof text === "string") return createSlateUserMessageInput(fields as unknown as SlateUserMessageInput)
  }
  return fromInteropUserMessage(decodeIncomingUserMessage(value))
}

export function decodeIncomingRequestContext(value: unknown) {
  return fromRedactedRequestContext(value as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
}

export function isInteropAskMode(value: unknown): boolean {
  return value === AgentMode.ASK
}

export function isInteropMultitaskMode(value: unknown): boolean {
  return value === AgentMode.MULTITASK
}

/** Converts counterpart mode and model markers into the host's tool-snapshot visibility decision. */
export function shouldHideMcpMetaToolSnapshot(input: {
  readonly mode: SlateModeValue
  readonly enableFilterEditToolsInAskMode: boolean | undefined
  readonly modelInfo: {
    readonly isLegacyAgentMatterhorn?: unknown
    readonly isRawTrainingSlug?: unknown
  } | undefined
}): boolean {
  const askModeRequiresFiltering = input.mode === SlateMode.CHAT &&
    (input.enableFilterEditToolsInAskMode ?? true)
  const capabilities = slateModelCapabilitiesFromInterop(input.modelInfo)
  const trainingModelRequiresFiltering = capabilities?.isLegacyAgentMatterhorn === true &&
    capabilities.isRawTrainingSlug === true
  return askModeRequiresFiltering || trainingModelRequiresFiltering
}
