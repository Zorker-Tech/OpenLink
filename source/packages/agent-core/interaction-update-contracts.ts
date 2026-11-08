import type { PrivacyMode } from "../redaction/privacy-mode.ts"

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
