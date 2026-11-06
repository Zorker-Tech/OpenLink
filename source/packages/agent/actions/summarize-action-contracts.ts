import type { Context } from "../../context/context.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import type { SlateMode as SlateModeValue } from "../mode-processing.ts"
import type { SlateConversationSummary } from "../conversation-summary-state.ts"
import type { SlateConversationState, SlateConversationTokenDetails } from "../conversation-state.ts"

export type SummarizeLooseValue = any

/** The versioned internal request to summarize the current conversation. */
export interface SlateSummarizeActionPayload {
  readonly schema: "slate.agent-action.summarize"
  readonly version: 1
}

export function createSlateSummarizeActionPayload(): SlateSummarizeActionPayload {
  return { schema: "slate.agent-action.summarize", version: 1 }
}

export function isSlateSummarizeActionPayload(value: unknown): value is SlateSummarizeActionPayload {
  if (value === null || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  return payload.schema === "slate.agent-action.summarize" && payload.version === 1
}

export interface SummarizeConfig {
  readonly toolsGenerator: (options: SummarizeLooseValue) => SummarizeLooseValue
  readonly systemPromptGenerator: (options: SummarizeLooseValue, toolSetHandle: SummarizeLooseValue) => SummarizeLooseValue
  readonly agentSessionId?: string
  readonly summarizeActionClearTurns?: boolean
  readonly fireAndForgetCheckpoints?: boolean
  readonly automationInstructions?: unknown
  readonly [key: string]: unknown
}

export interface SummarizeStateHandler {
  readonly mode?: SlateModeValue | undefined
  readonly tokenDetails: SlateConversationTokenDetails
  getBlobStore(): unknown
  getPrivacyMode(): PrivacyMode
  computeNewStructure(ctx: Context): Promise<SlateConversationState>
  setSummary(summary: SlateConversationSummary): void
  clearTurns(): Promise<void>
  setTokenDetails(tokenDetails: SlateConversationTokenDetails): void
}

export interface RootPromptExecutor {
  getMessages(): readonly SummarizeLooseValue[]
  appendMessages(messages: readonly SummarizeLooseValue[]): void
}
