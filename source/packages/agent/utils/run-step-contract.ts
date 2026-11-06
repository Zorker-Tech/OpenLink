import type { SlateConversationTokenDetails } from "../conversation-state.ts"

export type RunStepTokenDetails = SlateConversationTokenDetails

interface TurnTokenCounts {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

interface CacheTokenCounts {
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export type RunStepTurnUsage = TurnTokenCounts & CacheTokenCounts

export interface RunStepCheckpointState {
  readonly pendingToolCalls?: readonly string[]
}

interface RunStepUsageReporter<TokenDetails> {
  setTokenDetails(tokenDetails: TokenDetails): void
  addTurnUsage(usage: RunStepTurnUsage): void
}

export interface RunStepStateHandlerContract<
  Context = unknown,
  State extends RunStepCheckpointState = RunStepCheckpointState,
  TokenDetails = RunStepTokenDetails,
> extends RunStepUsageReporter<TokenDetails> {
  computeNewStructure(ctx: Context): Promise<State> | State
}

export interface RunStepCheckpointControls {
  readonly fireAndForgetCheckpoints: boolean
  readonly skipErrorStateCheckpoint: boolean
}
