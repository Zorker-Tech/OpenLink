/** Reads the provider-only marker that says a user message carries a prior summary. */
import {
  createRedactedConversationTokenDetails,
  fromRedactedPromptTokenBreakdownSnapshot,
  toRedactedPromptTokenBreakdownSnapshot,
} from "../redacted-protos/generated/agent/v1/agent_redacted.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts"
import type { PromptTokenBreakdownSnapshotValue } from "../../../packages/agent/utils/prompt-usage-contracts.ts"
import { promptTokenBreakdownFromProto, promptTokenBreakdownToProto } from "./redacted-prompt-token-details-adapter.ts"

export function isInteropSummaryPromptMessage(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false
  const fields = message as {
    readonly role?: unknown
    readonly providerOptions?: {
      readonly cursor?: { readonly isSummary?: unknown } | undefined
    } | undefined
  }
  return fields.role === "user" && fields.providerOptions?.cursor?.isSummary === true
}

export function decodeInteropPromptTokenBreakdown(value: unknown): PromptTokenBreakdownSnapshotValue {
  const decoded = fromRedactedPromptTokenBreakdownSnapshot(
    value as Parameters<typeof fromRedactedPromptTokenBreakdownSnapshot>[0],
    PrivacyCapability.UNSAFE_ALWAYS_ALLOWED,
    undefined,
  )
  return promptTokenBreakdownFromProto(decoded)
}

export function encodeInteropPromptTokenBreakdown(
  value: PromptTokenBreakdownSnapshotValue | undefined,
  privacyMode: PrivacyMode,
) {
  return value === undefined
    ? undefined
    : toRedactedPromptTokenBreakdownSnapshot(promptTokenBreakdownToProto(value), privacyMode)
}

export function createInteropConversationTokenDetails(
  privacyMode: PrivacyMode,
  options: {
    readonly usedTokens: number
    readonly maxTokens: unknown
    readonly breakdown: ReturnType<typeof encodeInteropPromptTokenBreakdown>
    readonly promptContextUsageTree: undefined
  },
) {
  return createRedactedConversationTokenDetails(privacyMode, options as never)
}
