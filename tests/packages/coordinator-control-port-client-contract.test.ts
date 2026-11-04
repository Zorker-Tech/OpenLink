import assert from "node:assert/strict"
import { test } from "node:test"

import {
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorFrame,
} from "../../source/shared/rpc/coordinator-port.ts"
import {
  ControlPortCallError,
  createControlPortClient,
} from "../../source/coordinator/control-port-client.ts"
import type { CoordinatorEndpoint } from "../../source/coordinator/control-port-client.ts"

type ControlClient = ReturnType<typeof createControlPortClient>

function call(client: ControlClient, method: string, args: unknown): Promise<unknown> {
  const invoke = client.commands[method]
  assert.equal(typeof invoke, "function", `command ${method} should be callable`)
  return invoke!(args)
}

function clientHarness() {
  const posted: CoordinatorFrame[] = []
  let closeCount = 0
  const endpoint: CoordinatorEndpoint = {
    post(frame) { posted.push(frame) },
    close() { closeCount += 1 },
  }
  return {
    client: createControlPortClient(endpoint),
    posted,
    closeCount: () => closeCount,
  }
}

test("the client opens with a versioned hello and gives each call a monotonic request id", async () => {
  const harness = clientHarness()
  assert.deepEqual(harness.posted, [{ kind: "lifecycle", phase: "hello", protocolVersion: COORDINATOR_PROTOCOL_VERSION }])

  const first = call(harness.client, "loadState", { root: "one" })
  const second = call(harness.client, "listAgents", undefined)
  assert.deepEqual(harness.posted.slice(1), [
    { kind: "request", requestId: "c-1", method: "loadState", args: { root: "one" } },
    { kind: "request", requestId: "c-2", method: "listAgents", args: undefined },
  ])

  harness.client.handleMessage({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION })
  harness.client.handleMessage({ kind: "reply", requestId: "c-2", outcome: { status: "ok", value: ["agent"] } })
  harness.client.handleMessage({ kind: "reply", requestId: "c-1", outcome: { status: "ok", value: { ready: true } } })
  assert.deepEqual(await first, { ready: true })
  assert.deepEqual(await second, ["agent"])
})

test("a failed reply rejects with the port error's code and message", async () => {
  const harness = clientHarness()
  const outcome = call(harness.client, "saveState", { value: 1 })
  harness.client.handleMessage({
    kind: "reply",
    requestId: "c-1",
    outcome: { status: "failed", failure: { code: "read-only", message: "state was not saved" } },
  })

  await assert.rejects(outcome, error => {
    assert.equal(error instanceof ControlPortCallError, true)
    assert.equal((error as ControlPortCallError).code, "read-only")
    assert.equal((error as Error).message, "read-only: state was not saved")
    return true
  })
})

test("unknown replies are ignored while the matching request is still pending", async () => {
  const harness = clientHarness()
  const result = call(harness.client, "readState", null)
  harness.client.handleMessage({ kind: "reply", requestId: "unknown", outcome: { status: "ok", value: "ignored" } })
  harness.client.handleMessage({ kind: "reply", requestId: "c-1", outcome: { status: "ok", value: "found" } })
  assert.equal(await result, "found")
  assert.equal(harness.closeCount(), 0)
})

test("closing the peer rejects all outstanding calls, settles once and blocks later posts", async () => {
  const harness = clientHarness()
  const one = call(harness.client, "first", undefined)
  const two = call(harness.client, "second", undefined)
  const settled = harness.client.settled

  harness.client.handlePortClosed()
  assert.deepEqual(await settled, { outcome: "port-closed" })
  await assert.rejects(one, /control port settled \(port-closed\) before the reply/)
  await assert.rejects(two, /control port settled \(port-closed\) before the reply/)
  harness.client.handlePortClosed()
  harness.client.postEvent("ignored", {})
  harness.client.handleMessage({ kind: "reply", requestId: "c-1", outcome: { status: "ok", value: null } })
  await assert.rejects(call(harness.client, "later", undefined), /settled before later was posted/)

  assert.equal(harness.closeCount(), 1)
  assert.equal(harness.posted.length, 3)
})

test("local shutdown posts its reason, closes the endpoint and resolves the settlement", async () => {
  const harness = clientHarness()
  const settled = harness.client.settled
  harness.client.shutdown()

  assert.deepEqual(harness.posted.at(-1), { kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null })
  assert.deepEqual(await settled, { outcome: "shutdown-requested" })
  assert.equal(harness.closeCount(), 1)
})

test("ready must match the supported version and may arrive only once", async () => {
  const wrongVersion = clientHarness()
  const wrongVersionSettled = wrongVersion.client.settled
  wrongVersion.client.handleMessage({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION + 1 })
  assert.deepEqual(await wrongVersionSettled, {
    outcome: "protocol-breach",
    detail: `ready.protocolVersion ${COORDINATOR_PROTOCOL_VERSION + 1} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`,
  })
  assert.deepEqual(wrongVersion.posted.at(-1), {
    kind: "lifecycle",
    phase: "shutdown",
    reason: "protocol-error",
    detail: `ready.protocolVersion ${COORDINATOR_PROTOCOL_VERSION + 1} is not the supported ${COORDINATOR_PROTOCOL_VERSION}`,
  })

  const repeated = clientHarness()
  const repeatedSettled = repeated.client.settled
  repeated.client.handleMessage({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION })
  repeated.client.handleMessage({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION })
  assert.deepEqual(await repeatedSettled, { outcome: "protocol-breach", detail: "ready repeated on a live control session" })
  assert.equal(repeated.closeCount(), 1)
})

test("malformed frames and client-direction messages breach the session", async () => {
  const malformed = clientHarness()
  const malformedSettled = malformed.client.settled
  malformed.client.handleMessage(null)
  assert.deepEqual(await malformedSettled, { outcome: "protocol-breach", detail: "frame must be an object" })

  const wrongDirection = clientHarness()
  const directionSettled = wrongDirection.client.settled
  wrongDirection.client.handleMessage({ kind: "event", family: "host-event", payload: null })
  assert.deepEqual(await directionSettled, { outcome: "protocol-breach", detail: "main posted a client-direction event frame" })
})

test("events are posted only while the control session is serving", async () => {
  const harness = clientHarness()
  harness.client.postEvent("state", { value: 1 })
  harness.client.shutdown()
  harness.client.postEvent("state", { value: 2 })

  assert.deepEqual(harness.posted.slice(1), [
    { kind: "event", family: "state", payload: { value: 1 } },
    { kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null },
  ])
  assert.equal(harness.closeCount(), 1)
})
