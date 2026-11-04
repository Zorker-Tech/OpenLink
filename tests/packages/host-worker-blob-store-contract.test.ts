import assert from "node:assert/strict"
import test from "node:test"
import { WorkerBlobStore } from "../../source/host/agents/isolation/worker-blob-store.ts"

test("the worker blob store binds its agent and database paths to each operation", async () => {
  const calls: unknown[][] = []
  const blobId = new Uint8Array([1, 2])
  const bytes = new Uint8Array([3, 4])
  const context = { caller: "ignored" }
  const pool = {
    async getBlob(...args: unknown[]) {
      calls.push(["get", ...args])
      return bytes
    },
    async setBlob(...args: unknown[]) {
      calls.push(["set", ...args])
    },
  }
  const store = new WorkerBlobStore(pool as never, "agent-1", "/store/agent.db", "/store/legacy.db")

  assert.equal(await store.getBlob(context, blobId), bytes)
  await store.setBlob(context, blobId, bytes)
  await store.setBlobLocallyOnly(context, blobId, bytes)
  await store.flush(context)

  assert.deepEqual(calls, [
    ["get", "agent-1", "/store/agent.db", blobId, "/store/legacy.db"],
    ["set", "agent-1", "/store/agent.db", blobId, bytes, "/store/legacy.db"],
    ["set", "agent-1", "/store/agent.db", blobId, bytes, "/store/legacy.db"],
  ])
})

test("an absent legacy database is passed through as absent", async () => {
  let received: unknown[] | undefined
  const store = new WorkerBlobStore({
    async getBlob(...args: unknown[]) {
      received = args
      return undefined
    },
  } as never, "agent-2", "/store/agent.db")
  const id = new Uint8Array([5])

  assert.equal(await store.getBlob({}, id), undefined)
  assert.deepEqual(received, ["agent-2", "/store/agent.db", id, undefined])
})
