import assert from "node:assert/strict"
import test from "node:test"

import {
  experimentLogUrlAllowed,
  experimentNetworkOverride,
  SLATE_EXPERIMENT_LOG_ENDPOINT,
} from "../../source/adapters/interop/experiments/experiment-bootstrap-adapter.ts"

test("experiment logging only leaves through the configured endpoint", async () => {
  const calls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input))
    return new Response("accepted", { status: 200 })
  }

  assert.equal(experimentLogUrlAllowed(SLATE_EXPERIMENT_LOG_ENDPOINT), true)
  assert.equal(experimentLogUrlAllowed("https://outside.invalid/log"), false)
  const sent = await experimentNetworkOverride(SLATE_EXPERIMENT_LOG_ENDPOINT, { method: "POST" }, fetchImpl)
  const suppressed = await experimentNetworkOverride("https://outside.invalid/log", { method: "POST" }, fetchImpl)

  assert.deepEqual([sent.status, suppressed.status, calls], [200, 204, [SLATE_EXPERIMENT_LOG_ENDPOINT]])
})
