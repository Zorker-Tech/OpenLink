import {
  DataClassification,
  PrivacyCapability,
} from "../redaction/classification.ts"
import { createRedactedString } from "../redaction/create.ts"
import { isRedactedString } from "../redaction/redacted-values.ts"
import type {
  SlateActiveBranchChangeUpdate,
  SlateHeartbeatUpdate,
  SlateInteractionUpdate,
  SlatePromptSuggestionUpdate,
  SlateRedactedActiveBranchChangeUpdate,
  SlateRedactedHeartbeatUpdate,
  SlateRedactedInteractionUpdate,
  SlateRedactedPromptSuggestionUpdate,
  SlateRedactedStepCompletedUpdate,
  SlateRedactedStepStartedUpdate,
  SlateRedactedThinkingCompletedUpdate,
  SlateRedactedThinkingDeltaUpdate,
  SlateRedactedTextDeltaUpdate,
  SlateRedactedTokenDeltaUpdate,
  SlateStepCompletedUpdate,
  SlateStepStartedUpdate,
  SlateThinkingCompletedUpdate,
  SlateThinkingDeltaUpdate,
  SlateThinkingStyle,
  SlateTextDeltaUpdate,
  SlateTokenDeltaUpdate,
  SlateRedactedTurnEndedUpdate,
  SlateTurnEndedUpdate,
  TurnUsage,
} from "./interaction-update-contracts.ts"
import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../redaction/privacy-mode.ts"

function isPrivacyMode(value: unknown): value is PrivacyModeValue {
  return Object.values(PrivacyMode).includes(value as PrivacyModeValue)
}

function tokenCountSnapshot(value: number): number {
  if (!Number.isInteger(value)) throw new RangeError("Turn usage must contain integer token counts")
  if (value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, value)
}

function isTurnUsage(value: unknown): value is TurnUsage {
  if (typeof value !== "object" || value === null) return false
  const usage = value as Record<string, unknown>
  const requiredCounts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
  return requiredCounts.every(count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    && (usage.reasoningTokens === undefined || typeof usage.reasoningTokens === "number" && Number.isSafeInteger(usage.reasoningTokens) && usage.reasoningTokens >= 0)
}

function turnUsageSnapshot(usage: TurnUsage): TurnUsage {
  return {
    inputTokens: tokenCountSnapshot(usage.inputTokens),
    outputTokens: tokenCountSnapshot(usage.outputTokens),
    cacheReadTokens: tokenCountSnapshot(usage.cacheReadTokens),
    cacheWriteTokens: tokenCountSnapshot(usage.cacheWriteTokens),
    reasoningTokens: tokenCountSnapshot(usage.reasoningTokens ?? 0),
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

/** Translate the supported thinking presentation preference into Slate's own vocabulary. */
export function slateThinkingStyleFromValue(value: unknown): SlateThinkingStyle | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return { kind: "custom", value }
  if (typeof value !== "number" || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    return undefined
  }
  switch (value) {
    case 0: return "unspecified"
    case 1: return "standard"
    case 2: return "code-oriented"
    case 3: return "alternate"
    default: return { kind: "unknown", code: value }
  }
}

export const SlateInteractionUpdates = {
  textDelta(text: string): SlateTextDeltaUpdate {
    return { kind: "text-delta", text }
  },
  tokenDelta(tokens: number): SlateTokenDeltaUpdate {
    return { kind: "token-delta", tokens }
  },
  thinkingDelta(text: string, style?: unknown): SlateThinkingDeltaUpdate {
    const thinkingStyle = slateThinkingStyleFromValue(style)
    return {
      kind: "thinking-delta",
      text,
      ...(thinkingStyle === undefined ? {} : { style: thinkingStyle }),
    }
  },
  thinkingCompleted(durationMs: number): SlateThinkingCompletedUpdate {
    return { kind: "thinking-completed", durationMs }
  },
  heartbeat(): SlateHeartbeatUpdate {
    return { kind: "heartbeat" }
  },
  stepStarted(stepId: number): SlateStepStartedUpdate {
    return { kind: "step-started", stepId }
  },
  stepCompleted(stepId: number, durationMs: number): SlateStepCompletedUpdate {
    return { kind: "step-completed", stepId, durationMs }
  },
  promptSuggestion(suggestion: string): SlatePromptSuggestionUpdate {
    return { kind: "prompt-suggestion", suggestion }
  },
  activeBranchChange(path: string, branchName: string): SlateActiveBranchChangeUpdate {
    return { kind: "active-branch-change", path, branchName }
  },
}

export const SlateRedactedInteractionUpdates = {
  textDelta(text: string, privacyMode: PrivacyMode): SlateRedactedTextDeltaUpdate {
    return {
      kind: "text-delta",
      privacyMode,
      text: createRedactedString(text, DataClassification.CODE, "text", privacyMode),
    }
  },
  tokenDelta(tokens: number, privacyMode: PrivacyMode): SlateRedactedTokenDeltaUpdate {
    return { kind: "token-delta", privacyMode, tokens }
  },
  thinkingDelta(text: string, privacyMode: PrivacyMode, style?: SlateThinkingStyle): SlateRedactedThinkingDeltaUpdate {
    return {
      kind: "thinking-delta",
      privacyMode,
      text: createRedactedString(text, DataClassification.CODE, "text", privacyMode),
      ...(style === undefined ? {} : { style }),
    }
  },
  thinkingCompleted(durationMs: number, privacyMode: PrivacyMode): SlateRedactedThinkingCompletedUpdate {
    return { kind: "thinking-completed", privacyMode, durationMs }
  },
  heartbeat(privacyMode: PrivacyMode): SlateRedactedHeartbeatUpdate {
    return { kind: "heartbeat", privacyMode }
  },
  stepStarted(stepId: number, privacyMode: PrivacyMode): SlateRedactedStepStartedUpdate {
    return { kind: "step-started", privacyMode, stepId }
  },
  stepCompleted(stepId: number, durationMs: number, privacyMode: PrivacyMode): SlateRedactedStepCompletedUpdate {
    return { kind: "step-completed", privacyMode, stepId, durationMs }
  },
  promptSuggestion(suggestion: string, privacyMode: PrivacyMode): SlateRedactedPromptSuggestionUpdate {
    return {
      kind: "prompt-suggestion",
      privacyMode,
      suggestion: createRedactedString(suggestion, DataClassification.CODE, "suggestion", privacyMode),
    }
  },
  activeBranchChange(path: string, branchName: string, privacyMode: PrivacyMode): SlateRedactedActiveBranchChangeUpdate {
    return {
      kind: "active-branch-change",
      privacyMode,
      path: createRedactedString(path, DataClassification.PATH, "path", privacyMode),
      branchName,
    }
  },
  turnEnded(privacyMode: PrivacyMode, usage?: TurnUsage): SlateRedactedTurnEndedUpdate {
    return slateRedactedTurnEndedUpdate(privacyMode, usage)
  },
}

/** Redact only content-bearing fields; counts and lifecycle metadata keep their product values. */
export function redactSlateInteractionUpdate(
  update: SlateInteractionUpdate,
  privacyMode: PrivacyMode,
): SlateRedactedInteractionUpdate {
  switch (update.kind) {
    case "text-delta": return SlateRedactedInteractionUpdates.textDelta(update.text, privacyMode)
    case "token-delta": return SlateRedactedInteractionUpdates.tokenDelta(update.tokens, privacyMode)
    case "thinking-delta": return SlateRedactedInteractionUpdates.thinkingDelta(update.text, privacyMode, update.style)
    case "thinking-completed": return SlateRedactedInteractionUpdates.thinkingCompleted(update.durationMs, privacyMode)
    case "heartbeat": return SlateRedactedInteractionUpdates.heartbeat(privacyMode)
    case "step-started": return SlateRedactedInteractionUpdates.stepStarted(update.stepId, privacyMode)
    case "step-completed": return SlateRedactedInteractionUpdates.stepCompleted(update.stepId, update.durationMs, privacyMode)
    case "prompt-suggestion": return SlateRedactedInteractionUpdates.promptSuggestion(update.suggestion, privacyMode)
    case "active-branch-change": return SlateRedactedInteractionUpdates.activeBranchChange(update.path, update.branchName, privacyMode)
    case "turn-ended": return SlateRedactedInteractionUpdates.turnEnded(privacyMode, update.usage)
  }
}

/** Read an internal redacted event for the listener's explicit always-allowed in-process projection. */
export function unredactSlateInteractionUpdate(update: SlateRedactedInteractionUpdate): SlateInteractionUpdate {
  switch (update.kind) {
    case "text-delta":
      return { kind: update.kind, text: update.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) }
    case "token-delta":
      return { kind: update.kind, tokens: update.tokens }
    case "thinking-delta":
      return {
        kind: update.kind,
        text: update.text.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        ...(update.style === undefined ? {} : { style: update.style }),
      }
    case "thinking-completed":
      return { kind: update.kind, durationMs: update.durationMs }
    case "heartbeat":
      return { kind: update.kind }
    case "step-started":
      return { kind: update.kind, stepId: update.stepId }
    case "step-completed":
      return { kind: update.kind, stepId: update.stepId, durationMs: update.durationMs }
    case "prompt-suggestion":
      return { kind: update.kind, suggestion: update.suggestion.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) }
    case "active-branch-change":
      return {
        kind: update.kind,
        path: update.path.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED),
        branchName: update.branchName,
      }
    case "turn-ended":
      return update.usage === undefined
        ? { kind: update.kind }
        : { kind: update.kind, usage: { ...update.usage } }
  }
}

export function isSlateThinkingStyle(value: unknown): value is SlateThinkingStyle {
  if (value === "unspecified" || value === "standard" || value === "code-oriented" || value === "alternate") return true
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly value?: unknown; readonly code?: unknown }
  return candidate.kind === "custom" && typeof candidate.value === "string"
    || candidate.kind === "unknown" && typeof candidate.code === "number" && Number.isInteger(candidate.code)
      && candidate.code >= -2_147_483_648 && candidate.code <= 2_147_483_647
}

export function isSlateInteractionUpdate(value: unknown): value is SlateInteractionUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  switch (candidate.kind) {
    case "text-delta": return typeof candidate.text === "string"
    case "token-delta": return typeof candidate.tokens === "number" && Number.isSafeInteger(candidate.tokens) && candidate.tokens >= 0
    case "thinking-delta": return typeof candidate.text === "string" && (candidate.style === undefined || isSlateThinkingStyle(candidate.style))
    case "thinking-completed": return typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
    case "heartbeat": return true
    case "step-started": return typeof candidate.stepId === "number" && Number.isSafeInteger(candidate.stepId) && candidate.stepId >= 0
    case "step-completed": return typeof candidate.stepId === "number" && Number.isSafeInteger(candidate.stepId) && candidate.stepId >= 0
      && typeof candidate.durationMs === "number" && Number.isSafeInteger(candidate.durationMs) && candidate.durationMs >= 0
    case "prompt-suggestion": return typeof candidate.suggestion === "string"
    case "active-branch-change": return typeof candidate.path === "string" && typeof candidate.branchName === "string"
    case "turn-ended": return isSlateTurnEndedUpdate(value)
    default: return false
  }
}

export function isSlateRedactedInteractionUpdate(value: unknown): value is SlateRedactedInteractionUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!isPrivacyMode(candidate.privacyMode)) return false
  switch (candidate.kind) {
    case "text-delta": return isRedactedString(candidate.text) && candidate.text.__privacyMode === candidate.privacyMode
    case "token-delta": return typeof candidate.tokens === "number" && Number.isSafeInteger(candidate.tokens) && candidate.tokens >= 0
    case "thinking-delta": return isRedactedString(candidate.text) && candidate.text.__privacyMode === candidate.privacyMode
      && (candidate.style === undefined || isSlateThinkingStyle(candidate.style))
    case "thinking-completed": return typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
    case "heartbeat": return true
    case "step-started": return typeof candidate.stepId === "number" && Number.isSafeInteger(candidate.stepId) && candidate.stepId >= 0
    case "step-completed": return typeof candidate.stepId === "number" && Number.isSafeInteger(candidate.stepId) && candidate.stepId >= 0
      && typeof candidate.durationMs === "number" && Number.isSafeInteger(candidate.durationMs) && candidate.durationMs >= 0
    case "prompt-suggestion": return isRedactedString(candidate.suggestion) && candidate.suggestion.__privacyMode === candidate.privacyMode
    case "active-branch-change": return isRedactedString(candidate.path) && candidate.path.__privacyMode === candidate.privacyMode
      && typeof candidate.branchName === "string"
    case "turn-ended": return isSlateRedactedTurnEndedUpdate(value)
    default: return false
  }
}

export function isSlateRedactedTurnEndedUpdate(value: unknown): value is SlateRedactedTurnEndedUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly privacyMode?: unknown; readonly usage?: unknown }
  return candidate.kind === "turn-ended" && isPrivacyMode(candidate.privacyMode)
    && (candidate.usage === undefined || isTurnUsage(candidate.usage))
}

export function isSlateTurnEndedUpdate(value: unknown): value is SlateTurnEndedUpdate {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly kind?: unknown; readonly usage?: unknown }
  return candidate.kind === "turn-ended"
    && (candidate.usage === undefined || isTurnUsage(candidate.usage))
}
