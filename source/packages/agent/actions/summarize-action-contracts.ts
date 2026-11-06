import type { Context } from "../../context/context.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import type { SlateMode as SlateModeValue } from "../mode-processing.ts"
import type { SlateConversationSummary } from "../conversation-summary-state.ts"
import type { SlateConversationTokenDetails } from "../conversation-state.ts"

export type SummarizeLooseValue = any

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
  computeNewStructure(ctx: Context): Promise<unknown>
  setSummary(summary: SlateConversationSummary): void
  clearTurns(): Promise<void>
  setTokenDetails(tokenDetails: SlateConversationTokenDetails): void
}

export interface RootPromptExecutor {
  getMessages(): readonly SummarizeLooseValue[]
  appendMessages(messages: readonly SummarizeLooseValue[]): void
}
