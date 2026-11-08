import type { SlateRedactedTurnEndedUpdate, SlateTurnEndedUpdate, TurnUsage } from "./interaction-update-contracts.ts"
import type { PrivacyMode } from "../redaction/privacy-mode.ts"

function turnUsageSnapshot(usage: TurnUsage): TurnUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
  }
}

/** Build a Slate-local lifecycle event without introducing a transport integer encoding. */
export function slateTurnEndedUpdate(usage?: TurnUsage): SlateTurnEndedUpdate {
  return usage === undefined
    ? { kind: "turn-ended" }
    : { kind: "turn-ended", usage: turnUsageSnapshot(usage) }
}

/** Redacted turn-end event. Counts are non-content metadata; privacy context stays explicit. */
export function slateRedactedTurnEndedUpdate(
  privacyMode: PrivacyMode,
  usage?: TurnUsage,
): SlateRedactedTurnEndedUpdate {
  return { ...slateTurnEndedUpdate(usage), privacyMode }
}

export function isSlateRedactedTurnEndedUpdate(value: unknown): value is SlateRedactedTurnEndedUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly privacyMode?: unknown; readonly usage?: unknown }
  return candidate.kind === "turn-ended" && candidate.privacyMode !== undefined
    && (candidate.usage === undefined || typeof candidate.usage === "object" && candidate.usage !== null)
}

export function isSlateTurnEndedUpdate(value: unknown): value is SlateTurnEndedUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly usage?: unknown }
  return candidate.kind === "turn-ended"
    && (candidate.usage === undefined || typeof candidate.usage === "object" && candidate.usage !== null)
}
