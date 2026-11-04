import assert from "node:assert/strict"
import test from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import type { BoxEnvironmentUpdate } from "../../source/host/boxes/box-env.ts"
import { applyBoxEnvironmentViaTransport } from "../../source/adapters/interop/agent/box-environment-transport-adapter.ts"

test("box environment updates use the selected control transport and copy their values", async () => {
  const ctx = createContext()
  const transport = { name: "control" }
  const update: BoxEnvironmentUpdate = { env: { SLATE_FEATURE: "on" }, replace: true }
  let received: unknown

  await applyBoxEnvironmentViaTransport(ctx, transport, update, selectedTransport => ({
    async updateEnvironmentVariables(receivedContext, request) {
      received = { transport: selectedTransport, ctx: receivedContext, request }
    },
  }))

  assert.deepEqual(received, {
    transport,
    ctx,
    request: { env: { SLATE_FEATURE: "on" }, replace: true },
  })
  assert.notEqual((received as { request: { env: object } }).request.env, update.env)
})

test("control-client failures propagate to the caller", async () => {
  const unavailable = new Error("control connection lost")
  await assert.rejects(applyBoxEnvironmentViaTransport(
    createContext(),
    {},
    { env: {}, replace: false },
    () => ({ async updateEnvironmentVariables() { throw unavailable } }),
  ), unavailable)
})
