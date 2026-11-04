import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import {
  metricsKey,
  type MetricHandle,
  type MetricLabels,
  type MetricsBackend,
} from "../../source/packages/metrics/index.ts"
import { recordGoalContinuationStarted, recordGoalTerminalTransition } from "../../source/packages/agent/goal-metrics.ts"

interface MetricCall {
  readonly method: "increment" | "histogram"
  readonly context: unknown
  readonly handle: MetricHandle
  readonly value: number
  readonly labels: MetricLabels | undefined
}

describe("durable goal metrics", () => {
  it("separates continuation starts from terminal outcomes and labels both terminal metrics alike", () => {
    const calls: MetricCall[] = []
    const backend: MetricsBackend = {
      record() {},
      increment(context, handle, value, labels) {
        calls.push({ method: "increment", context, handle, value, labels })
      },
      gauge() {},
      histogram(context, handle, value, labels) {
        calls.push({ method: "histogram", context, handle, value, labels })
      },
    }
    const context = createContext().with(metricsKey, backend)

    recordGoalContinuationStarted(context)
    recordGoalTerminalTransition(context, {
      status: "paused",
      reason: "anti_spin",
      continuationCount: 4,
    })

    assert.deepEqual(calls.map(({ method, handle, value, labels }) => [method, handle.name, handle.type, value, labels]), [
      ["increment", "agent.goal.continuation.started", "counter", 1, undefined],
      ["increment", "agent.goal.terminal_transition", "counter", 1, { status: "paused", reason: "anti_spin" }],
      ["histogram", "agent.goal.continuations_at_terminal", "histogram", 4, { status: "paused", reason: "anti_spin" }],
    ])
    assert.equal(calls.every(call => call.context === context), true)
  })
})
