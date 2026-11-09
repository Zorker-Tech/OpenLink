import type { PrivacyMode } from "../redaction/privacy-mode.ts"
import type { RedactedString } from "../redaction/redacted-values.ts"
import type { SlateToolCallText, SlateToolCallValue } from "../agent/conversation-step-state.ts"
import type { SlateUserMessage } from "../agent/user-message-state.ts"

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

export interface SlateFeedbackRequestCategory {
  readonly id: string
  readonly label: string
}

export interface SlateFeedbackRequestCategoryGroup {
  readonly id: string
  readonly prompt: string
  readonly categories: readonly SlateFeedbackRequestCategory[]
}

export interface SlateFeedbackRequestUpdate {
  readonly kind: "feedback-request"
  readonly requestId: string
  readonly canonicalModelName?: string
  readonly categories: readonly SlateFeedbackRequestCategory[]
  readonly categoryGroups: readonly SlateFeedbackRequestCategoryGroup[]
  readonly copy?: FeedbackRequestCopy
  readonly showFormImmediately?: boolean
}

export interface SlateRedactedFeedbackRequestUpdate extends SlateFeedbackRequestUpdate {
  readonly privacyMode: PrivacyMode
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

export interface SlateStepStartedUpdate {
  readonly kind: "step-started"
  readonly stepId: number
}

export interface SlateStepCompletedUpdate {
  readonly kind: "step-completed"
  readonly stepId: number
  readonly durationMs: number
}

export interface SlatePromptSuggestionUpdate {
  readonly kind: "prompt-suggestion"
  readonly suggestion: string
}

export interface SlateActiveBranchChangeUpdate {
  readonly kind: "active-branch-change"
  readonly path: string
  readonly branchName: string
}

export interface SlateSummaryUpdate {
  readonly kind: "summary"
  readonly text: string
}

export interface SlateSummaryStartedUpdate {
  readonly kind: "summary-started"
}

export interface SlateSummaryCompletedUpdate {
  readonly kind: "summary-completed"
  readonly hookMessage?: string
}

export interface SlateRedactedSummaryUpdate {
  readonly kind: "summary"
  readonly privacyMode: PrivacyMode
  readonly text: RedactedString
}

export interface SlateRedactedSummaryStartedUpdate extends SlateSummaryStartedUpdate {
  readonly privacyMode: PrivacyMode
}

export interface SlateRedactedSummaryCompletedUpdate {
  readonly kind: "summary-completed"
  readonly privacyMode: PrivacyMode
  readonly hookMessage?: RedactedString
}

export interface SlateInteractionToolCallValue {
  readonly toolCallId?: string
  readonly startedAtMs?: bigint
  readonly completedAtMs?: bigint
  readonly hookContexts: readonly { readonly event: string; readonly text: SlateToolCallText }[]
  readonly tool: SlateToolCallValue
}

export type SlateToolCallUpdatePhase = "started" | "partial" | "completed"

export interface SlateToolCallUpdate {
  readonly kind: "tool-call-update"
  readonly phase: SlateToolCallUpdatePhase
  readonly callId: string
  readonly modelCallId: string
  readonly toolCall?: SlateInteractionToolCallValue
}

export interface SlateRedactedToolCallUpdate extends SlateToolCallUpdate {
  readonly privacyMode: PrivacyMode
}

export type SlateToolCallDeltaValue =
  | { readonly kind: "edit-content"; readonly textDelta: SlateToolCallText }
  | { readonly kind: "shell-output"; readonly stream: "stdout" | "stderr"; readonly text: SlateToolCallText }
  | { readonly kind: "environment-assignment"; readonly environmentId: SlateToolCallText }
  | { readonly kind: "legacy"; readonly sourceCase?: string; readonly value?: unknown }

export interface SlateToolCallDeltaUpdate {
  readonly kind: "tool-call-delta"
  readonly callId: string
  readonly modelCallId: string
  readonly delta?: SlateToolCallDeltaValue
}

export interface SlateRedactedToolCallDeltaUpdate extends SlateToolCallDeltaUpdate {
  readonly privacyMode: PrivacyMode
}

export interface SlateUserMessageAppendedUpdate {
  readonly kind: "user-message-appended"
  readonly message: SlateUserMessage
}

export interface SlateRedactedUserMessageAppendedUpdate extends SlateUserMessageAppendedUpdate {
  readonly privacyMode: PrivacyMode
}

export type SlateInteractionUpdate =
  | SlateTurnEndedUpdate
  | SlateTextDeltaUpdate
  | SlateTokenDeltaUpdate
  | SlateThinkingDeltaUpdate
  | SlateThinkingCompletedUpdate
  | SlateHeartbeatUpdate
  | SlateStepStartedUpdate
  | SlateStepCompletedUpdate
  | SlatePromptSuggestionUpdate
  | SlateActiveBranchChangeUpdate
  | SlateSummaryUpdate
  | SlateSummaryStartedUpdate
  | SlateSummaryCompletedUpdate
  | SlateToolCallUpdate
  | SlateToolCallDeltaUpdate
  | SlateUserMessageAppendedUpdate
  | SlateFeedbackRequestUpdate

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

export interface SlateRedactedStepStartedUpdate {
  readonly kind: "step-started"
  readonly privacyMode: PrivacyMode
  readonly stepId: number
}

export interface SlateRedactedStepCompletedUpdate {
  readonly kind: "step-completed"
  readonly privacyMode: PrivacyMode
  readonly stepId: number
  readonly durationMs: number
}

export interface SlateRedactedPromptSuggestionUpdate {
  readonly kind: "prompt-suggestion"
  readonly privacyMode: PrivacyMode
  readonly suggestion: RedactedString
}

export interface SlateRedactedActiveBranchChangeUpdate {
  readonly kind: "active-branch-change"
  readonly privacyMode: PrivacyMode
  readonly path: RedactedString
  readonly branchName: string
}

export type SlateRedactedInteractionUpdate =
  | SlateRedactedTurnEndedUpdate
  | SlateRedactedTextDeltaUpdate
  | SlateRedactedTokenDeltaUpdate
  | SlateRedactedThinkingDeltaUpdate
  | SlateRedactedThinkingCompletedUpdate
  | SlateRedactedHeartbeatUpdate
  | SlateRedactedStepStartedUpdate
  | SlateRedactedStepCompletedUpdate
  | SlateRedactedPromptSuggestionUpdate
  | SlateRedactedActiveBranchChangeUpdate
  | SlateRedactedSummaryUpdate
  | SlateRedactedSummaryStartedUpdate
  | SlateRedactedSummaryCompletedUpdate
  | SlateRedactedToolCallUpdate
  | SlateRedactedToolCallDeltaUpdate
  | SlateRedactedUserMessageAppendedUpdate
  | SlateRedactedFeedbackRequestUpdate
