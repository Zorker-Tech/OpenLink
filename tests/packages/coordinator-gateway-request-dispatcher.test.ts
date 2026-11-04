import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { COORDINATOR_UNKNOWN_METHOD } from "../../source/shared/rpc/coordinator-port.ts"
import { SlateGatewayCommandError } from "../../source/coordinator/gateway/gateway-errors.ts"
import { SlateGatewayUnreachableError } from "../../source/coordinator/gateway/gateway-reachability-contracts.ts"
import {
  createGatewayRequestDispatch,
  GATEWAY_COMMAND_FAILED,
  GATEWAY_TRANSPORT_FAILED,
  GATEWAY_UNREACHABLE,
} from "../../source/coordinator/gateway/gateway-request-dispatcher.ts"

describe("coordinator gateway request dispatch", () => {
  it("rejects a method the coordinator does not serve without calling the gateway", async () => {
    let calls = 0
    const dispatch = createGatewayRequestDispatch({
      dispatchCommand: async () => {
        calls += 1
        return "unexpected"
      },
    })

    assert.deepEqual(await dispatch("futureMethod", {}, undefined), {
      status: "failed",
      failure: {
        code: COORDINATOR_UNKNOWN_METHOD,
        message: "no coordinator method named futureMethod",
      },
    })
    assert.equal(calls, 0)
  })

  it("passes a known request and its optional abort signal through, then returns the validated reply", async () => {
    const controller = new AbortController()
    const reply = { entries: [], threadCounts: { root: 0 } }
    let request: unknown
    const dispatch = createGatewayRequestDispatch({
      dispatchCommand: async (method, args, options) => {
        request = { method, args, options }
        return reply
      },
    })

    assert.deepEqual(await dispatch("getAgentTranscriptWindow", { id: "thread" }, controller.signal), {
      status: "ok",
      value: reply,
    })
    assert.deepEqual(request, {
      method: "getAgentTranscriptWindow",
      args: { id: "thread" },
      options: { signal: controller.signal },
    })
  })

  it("does not add an abort signal option when the caller omitted it", async () => {
    let options: unknown
    const dispatch = createGatewayRequestDispatch({
      dispatchCommand: async (_method, _args, receivedOptions) => {
        options = receivedOptions
        return null
      },
    })

    assert.deepEqual(await dispatch("getAgentTranscriptTail", {}, undefined), { status: "ok", value: null })
    assert.deepEqual(options, {})
  })

  it("keeps gateway command refusals distinct from reachability failures", async () => {
    const commandDispatch = createGatewayRequestDispatch({
      dispatchCommand: async () => {
        throw new SlateGatewayCommandError("permission denied")
      },
    })
    const unreachableDispatch = createGatewayRequestDispatch({
      dispatchCommand: async () => {
        throw new SlateGatewayUnreachableError("dns", "host could not be resolved")
      },
    })

    assert.deepEqual(await commandDispatch("sendPrompt", {}, undefined), {
      status: "failed",
      failure: { code: GATEWAY_COMMAND_FAILED, message: "permission denied" },
    })
    assert.deepEqual(await unreachableDispatch("sendPrompt", {}, undefined), {
      status: "failed",
      failure: { code: GATEWAY_UNREACHABLE, message: "host could not be resolved", transportKind: "dns" },
    })
  })

  it("classifies other thrown values as transport failures with a readable message", async () => {
    const errorDispatch = createGatewayRequestDispatch({ dispatchCommand: async () => { throw new Error("socket closed") } })
    const valueDispatch = createGatewayRequestDispatch({ dispatchCommand: async () => { throw "connection lost" } })

    assert.deepEqual(await errorDispatch("sendPrompt", {}, undefined), {
      status: "failed",
      failure: { code: GATEWAY_TRANSPORT_FAILED, message: "socket closed" },
    })
    assert.deepEqual(await valueDispatch("sendPrompt", {}, undefined), {
      status: "failed",
      failure: { code: GATEWAY_TRANSPORT_FAILED, message: "connection lost" },
    })
  })

  it("turns a malformed validated reply into a transport failure", async () => {
    const dispatch = createGatewayRequestDispatch({
      dispatchCommand: async () => ({ entries: [{ id: "entry-without-kind" }] }),
    })

    assert.deepEqual(await dispatch("getAgentThread", { id: "thread", rootId: "root" }, undefined), {
      status: "failed",
      failure: {
        code: GATEWAY_TRANSPORT_FAILED,
        message: "getAgentThread returned a malformed agent thread",
      },
    })
  })
})
