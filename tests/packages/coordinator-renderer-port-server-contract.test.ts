import assert from "node:assert/strict"
import { test } from "node:test"

import {
  COORDINATOR_CANCELLED,
  COORDINATOR_PROTOCOL_VERSION,
  COORDINATOR_UNKNOWN_METHOD,
  type CoordinatorFrame,
  type CoordinatorReplyOutcome,
} from "../../source/shared/rpc/coordinator-port.ts"
import {
  createRendererPortServer,
  type RendererPort,
  type RendererPortServerOptions,
} from "../../source/coordinator/renderer-port-server.ts"

function serverHarness(options: RendererPortServerOptions = {}) {
  const posted: CoordinatorFrame[] = []
  let closeCount = 0
  const port: RendererPort = {
    post(frame) { posted.push(frame) },
    close() { closeCount += 1 },
  }
  return {
    server: createRendererPortServer(port, options),
    posted,
    closeCount: () => closeCount,
    receive(frame: unknown) { this.server.handleMessage(frame) },
    open() { this.server.handleMessage({ kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION }) },
  }
}

function requests(replyFrames: readonly CoordinatorFrame[]) {
  return replyFrames.filter((frame): frame is Extract<CoordinatorFrame, { kind: "reply" }> => frame.kind === "reply")
}

test("the server waits for a versioned hello before serving or emitting events", async () => {
  let servingCount = 0
  const harness = serverHarness({ onServing: () => { servingCount += 1 } })
  harness.server.postEvent("state", { value: 1 })
  assert.deepEqual(harness.posted, [])

  harness.open()
  harness.server.postEvent("state", { value: 2 })
  assert.deepEqual(harness.posted, [
    { kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION },
    { kind: "event", family: "state", payload: { value: 2 } },
  ])
  assert.equal(servingCount, 1)
})

test("a wrong version or any request before hello closes the port as a protocol breach", async () => {
  const wrongVersion = serverHarness()
  wrongVersion.receive({ kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION + 1 })
  assert.deepEqual(await wrongVersion.server.settled, {
    outcome: "protocol-breach",
    detail: `hello.protocolVersion ${COORDINATOR_PROTOCOL_VERSION + 1} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`,
  })
  assert.equal(wrongVersion.closeCount(), 1)

  const early = serverHarness()
  early.receive({ kind: "request", requestId: "r1", method: "read", args: null })
  assert.deepEqual(await early.server.settled, { outcome: "protocol-breach", detail: "request frame before hello" })
})

test("requests are dispatched once and their outcomes are returned under the same id", async () => {
  const outcomes: CoordinatorReplyOutcome[] = [{ status: "ok", value: { ready: true } }]
  const received: Array<{ method: string; args: unknown; signal: AbortSignal }> = []
  const harness = serverHarness({
    dispatchRequest: async (method, args, signal) => {
      received.push({ method, args, signal })
      return outcomes[0]!
    },
  })
  harness.open()
  harness.receive({ kind: "request", requestId: "r-7", method: "read-state", args: { id: 7 } })
  await Promise.resolve()

  assert.deepEqual(received.map(({ method, args }) => [method, args]), [["read-state", { id: 7 }]])
  assert.equal(received[0]?.signal.aborted, false)
  assert.deepEqual(requests(harness.posted), [{ kind: "reply", requestId: "r-7", outcome: outcomes[0] }])
})

test("an unconfigured method table returns the explicit unknown-method failure", () => {
  const harness = serverHarness()
  harness.open()
  harness.receive({ kind: "request", requestId: "r1", method: "not-served", args: null })
  assert.deepEqual(requests(harness.posted), [{
    kind: "reply",
    requestId: "r1",
    outcome: { status: "failed", failure: { code: COORDINATOR_UNKNOWN_METHOD, message: "no method table serves this session yet" } },
  }])
})

test("cancel aborts the handler and sends one cancellation reply, ignoring a late result", async () => {
  let signal: AbortSignal | undefined
  let finish: ((outcome: CoordinatorReplyOutcome) => void) | undefined
  const harness = serverHarness({
    dispatchRequest: (_method, _args, currentSignal) => {
      signal = currentSignal
      return new Promise(resolve => { finish = resolve })
    },
  })
  harness.open()
  harness.receive({ kind: "request", requestId: "r2", method: "slow", args: null })
  harness.receive({ kind: "cancel", requestId: "r2" })
  assert.equal(signal?.aborted, true)
  assert.deepEqual(requests(harness.posted), [{
    kind: "reply",
    requestId: "r2",
    outcome: { status: "failed", failure: { code: COORDINATOR_CANCELLED, message: "request cancelled" } },
  }])

  finish?.({ status: "ok", value: "late" })
  await Promise.resolve()
  assert.equal(requests(harness.posted).length, 1)
})

test("reusing an in-flight request id breaches the session and aborts its original handler", async () => {
  let signal: AbortSignal | undefined
  const harness = serverHarness({
    dispatchRequest: (_method, _args, currentSignal) => {
      signal = currentSignal
      return new Promise(() => {})
    },
  })
  harness.open()
  harness.receive({ kind: "request", requestId: "same", method: "first", args: null })
  harness.receive({ kind: "request", requestId: "same", method: "second", args: null })

  assert.deepEqual(await harness.server.settled, { outcome: "protocol-breach", detail: "request.requestId same reused while in flight" })
  assert.equal(signal?.aborted, true)
  assert.equal(harness.closeCount(), 1)
  assert.deepEqual(harness.posted.at(-1), {
    kind: "lifecycle",
    phase: "shutdown",
    reason: "protocol-error",
    detail: "request.requestId same reused while in flight",
  })
})

test("a rejected dispatcher breaches the protocol instead of stranding a request", async () => {
  const harness = serverHarness({ dispatchRequest: async () => { throw new Error("unexpected rejection") } })
  harness.open()
  harness.receive({ kind: "request", requestId: "r3", method: "broken", args: null })
  assert.deepEqual(await harness.server.settled, {
    outcome: "protocol-breach",
    detail: "request r3 dispatch rejected instead of settling",
  })
})

test("the peer can close with pending work and the server aborts it only once", async () => {
  let signal: AbortSignal | undefined
  const harness = serverHarness({
    dispatchRequest: (_method, _args, currentSignal) => {
      signal = currentSignal
      return new Promise(() => {})
    },
  })
  harness.open()
  harness.receive({ kind: "request", requestId: "r4", method: "slow", args: null })
  harness.server.handlePortClosed()
  assert.deepEqual(await harness.server.settled, { outcome: "port-closed" })
  assert.equal(signal?.aborted, true)
  harness.server.handlePortClosed()
  assert.equal(harness.closeCount(), 1)
})

test("a requested shutdown frame aborts active work and completes the session", async () => {
  let signal: AbortSignal | undefined
  const harness = serverHarness({
    dispatchRequest: (_method, _args, currentSignal) => {
      signal = currentSignal
      return new Promise(() => {})
    },
  })
  harness.open()
  harness.receive({ kind: "request", requestId: "r5", method: "slow", args: null })
  harness.receive({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null })

  assert.deepEqual(await harness.server.settled, { outcome: "shutdown-requested" })
  assert.equal(signal?.aborted, true)
  assert.equal(harness.closeCount(), 1)
})
