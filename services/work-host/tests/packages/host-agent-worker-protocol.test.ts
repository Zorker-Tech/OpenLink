import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  parseAgentStoreWorkerBoot,
  parseAgentStoreWorkerCommand,
  parseAgentStoreWorkerReply,
} from "../../source/host/agents/isolation/agent-worker-protocol.ts"

describe("the agent-store worker protocol", () => {
  it("validates the worker identity and preserves its defaultable timeout", () => {
    assert.deepEqual(parseAgentStoreWorkerBoot({ agentId: "agent-1", blobDbPath: "/store.db" }), {
      agentId: "agent-1",
      blobDbPath: "/store.db",
    })
    assert.equal(parseAgentStoreWorkerBoot({ agentId: "", blobDbPath: "/store.db", busyTimeoutMs: 5 }), null)
    assert.equal(parseAgentStoreWorkerBoot({ agentId: "agent-1", blobDbPath: "/store.db", busyTimeoutMs: -1 }), null)
  })

  it("accepts only known commands with valid correlation ids and payload shapes", () => {
    assert.deepEqual(parseAgentStoreWorkerCommand({ operation: "worker.identify", callId: 1 }), {
      operation: "worker.identify",
      callId: 1,
    })
    assert.deepEqual(parseAgentStoreWorkerCommand({
      operation: "blob.write",
      callId: 2,
      blobId: new Uint8Array([1]),
      blobBytes: new Uint8Array([2]),
    }), {
      operation: "blob.write",
      callId: 2,
      blobId: new Uint8Array([1]),
      blobBytes: new Uint8Array([2]),
    })
    assert.equal(parseAgentStoreWorkerCommand({ operation: "blob.write", callId: 0, blobId: new Uint8Array(), blobBytes: new Uint8Array() }), null)
    assert.equal(parseAgentStoreWorkerCommand({ operation: "blob.read", callId: 3, blobId: [1, 2] }), null)
    assert.equal(parseAgentStoreWorkerCommand({ operation: "unknown", callId: 4 }), null)
    assert.equal(parseAgentStoreWorkerCommand(null), null)
  })

  it("accepts typed success payloads and bounded worker errors only", () => {
    assert.deepEqual(parseAgentStoreWorkerReply({
      outcome: "success",
      operation: "worker.identify",
      callId: 1,
      workerThreadId: 7,
      processId: 4242,
    }), {
      outcome: "success",
      operation: "worker.identify",
      callId: 1,
      workerThreadId: 7,
      processId: 4242,
    })
    assert.deepEqual(parseAgentStoreWorkerReply({
      outcome: "failure",
      callId: 2,
      message: "store unavailable",
      name: "StoreError",
      code: "EIO",
    }), {
      outcome: "failure",
      callId: 2,
      message: "store unavailable",
      name: "StoreError",
      code: "EIO",
    })
    assert.equal(parseAgentStoreWorkerReply({ outcome: "success", operation: "worker.identify", callId: 1, workerThreadId: "7", processId: 4242 }), null)
    assert.equal(parseAgentStoreWorkerReply({ outcome: "failure", callId: 2, message: "bad", code: 9 }), null)
    assert.equal(parseAgentStoreWorkerReply({ outcome: "success", operation: "unknown", callId: 3 }), null)
  })
})
