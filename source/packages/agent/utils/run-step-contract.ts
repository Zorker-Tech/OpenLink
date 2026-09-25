/**
 * The state surface a run step depends on.
 *
 * A step checkpoints what it has done and accounts for what it used, and it does both through the
 * state handler rather than by reaching into it. Writing the two things it may call here — and the two
 * switches that decide whether a checkpoint is written at all — keeps the step readable without the
 * state implementation, which is what makes the step's own behaviour testable.
 */

import type { createRedactedConversationTokenDetails } from "../../redacted-protos/generated/agent/v1/agent_redacted.ts"

export type RunStepTokenDetails = ReturnType<typeof createRedactedConversationTokenDetails>

export interface RunStepTurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

export interface RunStepCheckpointState {
  pendingToolCalls: unknown[]
}

export interface RunStepStateHandlerContract<
  Context = unknown,
  State extends RunStepCheckpointState = RunStepCheckpointState,
> {
  computeNewStructure(ctx: Context): Promise<State> | State
  setTokenDetails(tokenDetails: RunStepTokenDetails): void
  addTurnUsage(usage: RunStepTurnUsage): void
}

/** Whether a step writes its checkpoint when it finishes, and when it fails. */
export interface RunStepCheckpointControls {
  readonly fireAndForgetCheckpoints: boolean
  readonly skipErrorStateCheckpoint: boolean
}
