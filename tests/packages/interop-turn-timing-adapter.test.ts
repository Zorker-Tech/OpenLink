import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { StepTiming } from "../../source/adapters/interop/proto/generated/agent/v1/agent_pb.ts"
import { createInteropTurnTiming } from "../../source/adapters/interop/agent/turn-timing-adapter.ts"

describe("the turn timing interop adapter", () => {
  it("materializes a Slate timing record as the Agent state message", () => {
    const timing = createInteropTurnTiming({ timestampMs: 1_725_000_000_123n, durationMs: 450n })

    assert.ok(timing instanceof StepTiming)
    assert.equal(timing.timestampMs, 1_725_000_000_123n)
    assert.equal(timing.durationMs, 450n)
  })
})
