/** Decodes redacted incoming message values before the host's turn policy handles them. */

import { AgentMode } from "../proto/generated/agent/v1/agent_pb.ts"
import { fromRedactedRequestContext } from "../redacted-protos/generated/agent/v1/request_context_exec_redacted.ts"
import { fromRedactedUserMessage } from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { SlateMode, type SlateMode as SlateModeValue } from "../../../packages/agent/mode-processing.ts"

export function decodeIncomingUserMessage(value: unknown) {
  return fromRedactedUserMessage(value as never, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, undefined)
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
    readonly isComposerMatterhorn?: unknown
    readonly isRawTrainingSlug?: unknown
  } | undefined
}): boolean {
  const askModeRequiresFiltering = input.mode === SlateMode.CHAT &&
    (input.enableFilterEditToolsInAskMode ?? true)
  const trainingModelRequiresFiltering = input.modelInfo?.isComposerMatterhorn === true &&
    input.modelInfo.isRawTrainingSlug === true
  return askModeRequiresFiltering || trainingModelRequiresFiltering
}
