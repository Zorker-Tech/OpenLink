import assert from "node:assert/strict"
import { test } from "node:test"

import { BackgroundSubagentActionHandler } from "../../source/packages/agent/actions/background-subagent-action-handler.ts"
import { createContext } from "../../source/packages/context/context.ts"

test("a subagent completion recomputes state once and returns that state", async () => {
  const context = createContext()
  const nextState = { revision: 8 }
  const calls: unknown[] = []
  const handler = new BackgroundSubagentActionHandler()

  const result = await handler.handle(
    context,
    { action: "completion" },
    { ignored: true },
    { computeNewStructure: (actualContext: unknown) => { calls.push(actualContext); return nextState } },
    { ignored: true },
    { ignored: true },
  )

  assert.strictEqual(result, nextState)
  assert.deepEqual(calls, [context])
})

test("single-step handling reports no tool after awaiting the recomputed state", async () => {
  const context = createContext()
  const nextState = { revision: 9 }
  let calls = 0
  const handler = new BackgroundSubagentActionHandler()

  const result = await handler.handleSingleStep(
    context,
    { action: "completion" },
    { ignored: true },
    { computeNewStructure: async () => { calls += 1; return nextState } },
    { ignored: true },
    { ignored: true },
  )

  assert.deepEqual(result, { state: nextState, hasToolCall: false })
  assert.equal(calls, 1)
})
