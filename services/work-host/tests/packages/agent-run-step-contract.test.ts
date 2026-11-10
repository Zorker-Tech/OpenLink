import assert from "node:assert/strict"
import test from "node:test"

import type {
  RunStepCheckpointControls,
  RunStepCheckpointState,
  RunStepStateHandlerContract,
  RunStepTokenDetails,
  RunStepTurnUsage,
} from "../../source/packages/agent/utils/run-step-contract.ts"

interface CheckpointState extends RunStepCheckpointState {
  readonly revision: number
}

test("run-step state operations and checkpoint controls have first-party contracts", async () => {
  const events: unknown[] = []
  const handler: RunStepStateHandlerContract<number, CheckpointState> = {
    computeNewStructure: revision => ({ revision, pendingToolCalls: [] }),
    setTokenDetails: details => events.push(["token-details", details]),
    addTurnUsage: usage => events.push(["usage", usage]),
  }
  const details: RunStepTokenDetails = {
    usedTokens: 7,
    maximumTokens: 20,
  }
  const usage: RunStepTurnUsage = {
    inputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
  }
  const controls: RunStepCheckpointControls = {
    fireAndForgetCheckpoints: true,
    skipErrorStateCheckpoint: false,
  }

  assert.deepEqual(await handler.computeNewStructure(5), { revision: 5, pendingToolCalls: [] })
  handler.setTokenDetails(details)
  handler.addTurnUsage(usage)
  assert.deepEqual(events, [["token-details", details], ["usage", usage]])
  assert.deepEqual(controls, { fireAndForgetCheckpoints: true, skipErrorStateCheckpoint: false })
})
