import assert from "node:assert/strict"
import test from "node:test"

import { telemetryAuthToken } from "../../source/adapters/interop/telemetry/analytics-client-adapter.ts"
import { createSlateAnalyticsTokenProvider } from "../../source/adapters/interop/analytics/analytics-client.ts"

test("analytics delivery keeps a credential when one is available", async () => {
  assert.equal(await telemetryAuthToken(async () => "token-value", { request: true }), "token-value")
})

test("credential lookup failure still permits an unauthenticated log attempt", async () => {
  assert.equal(await telemetryAuthToken(async () => { throw new Error("credential service unavailable") }, {}), "")
})

test("the analytics adapter adds its endpoint when requesting a token", async () => {
  const requests: Array<{ backendUrl: string }> = []
  const provider = createSlateAnalyticsTokenProvider(async (request) => {
    requests.push(request)
    return "token-value"
  }, "https://analytics.invalid")

  assert.equal(await provider.getAccessToken(), "token-value")
  assert.deepEqual(requests, [{ backendUrl: "https://analytics.invalid" }])
})

test("the analytics adapter turns empty or unavailable credentials into no token", async () => {
  const empty = createSlateAnalyticsTokenProvider(async () => "", "https://analytics.invalid")
  const unavailable = createSlateAnalyticsTokenProvider(async () => { throw new Error("credential service unavailable") }, "https://analytics.invalid")

  assert.equal(await empty.getAccessToken(), null)
  assert.equal(await unavailable.getAccessToken(), null)
})
