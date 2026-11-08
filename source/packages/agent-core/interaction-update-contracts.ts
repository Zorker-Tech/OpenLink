import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { RedactedString } from "../redaction/redacted-values.ts"

/** Slate-owned inputs used when describing streamed agent usage and feedback copy. */
export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens?: number
}

export interface FeedbackRequestCopy {
  readonly title?: string
  readonly negativeTitle?: string
  readonly commentPlaceholder?: string
}

/** Slate's local run event for the end of one agent turn. */
export interface SlateTurnEndedUpdate {
  readonly kind: "turn-ended"
  readonly usage?: TurnUsage
}

/** Turn-ended usage contains counts only; privacy context is retained for consistent run handling. */
export interface SlateRedactedTurnEndedUpdate extends SlateTurnEndedUpdate {
  readonly privacyMode: PrivacyMode
}

export interface SlateTextDeltaUpdate {
  readonly kind: "text-delta"
  readonly text: string
}

export interface SlateTokenDeltaUpdate {
  readonly kind: "token-delta"
  readonly tokens: number
}

export type SlateThinkingStyle =
  | "unspecified"
  | "standard"
  | "code-oriented"
  | "alternate"
  | { readonly kind: "custom"; readonly value: string }
  | { readonly kind: "unknown"; readonly code: number }

export interface SlateThinkingDeltaUpdate {
  readonly kind: "thinking-delta"
  readonly text: string
  readonly style?: SlateThinkingStyle
}

export interface SlateThinkingCompletedUpdate {
  readonly kind: "thinking-completed"
  readonly durationMs: number
}

export interface SlateHeartbeatUpdate {
  readonly kind: "heartbeat"
}

export type SlateInteractionUpdate =
  | SlateTurnEndedUpdate
  | SlateTextDeltaUpdate
  | SlateTokenDeltaUpdate
  | SlateThinkingDeltaUpdate
  | SlateThinkingCompletedUpdate
  | SlateHeartbeatUpdate

export interface SlateRedactedTextDeltaUpdate {
  readonly kind: "text-delta"
  readonly privacyMode: PrivacyMode
  readonly text: RedactedString
}

export interface SlateRedactedTokenDeltaUpdate {
  readonly kind: "token-delta"
  readonly privacyMode: PrivacyMode
  readonly tokens: number
}

export interface SlateRedactedThinkingDeltaUpdate {
  readonly kind: "thinking-delta"
  readonly privacyMode: PrivacyMode
  readonly text: RedactedString
  readonly style?: SlateThinkingStyle
}

export interface SlateRedactedThinkingCompletedUpdate {
  readonly kind: "thinking-completed"
  readonly privacyMode: PrivacyMode
  readonly durationMs: number
}

export interface SlateRedactedHeartbeatUpdate {
  readonly kind: "heartbeat"
  readonly privacyMode: PrivacyMode
}

export type SlateRedactedInteractionUpdate =
  | SlateRedactedTurnEndedUpdate
  | SlateRedactedTextDeltaUpdate
  | SlateRedactedTokenDeltaUpdate
  | SlateRedactedThinkingDeltaUpdate
  | SlateRedactedThinkingCompletedUpdate
  | SlateRedactedHeartbeatUpdate
