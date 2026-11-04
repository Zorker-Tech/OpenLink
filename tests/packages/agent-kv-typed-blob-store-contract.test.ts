import assert from "node:assert/strict"
import { test } from "node:test"

import { createContext } from "../../source/packages/context/context.ts"
import type { BlobStore } from "../../source/packages/agent-kv/blob-store.ts"
import {
  metadataObserverForStore,
  ensureBlobVisibleToCloudMirror,
  ObservedBlobStore,
  underlyingBlobStore,
} from "../../source/packages/agent-kv/typed-blob-store.ts"

type Context = ReturnType<typeof createContext>

test("blob metadata callbacks belong to the outer wrapper and unwrapping reaches the raw store", () => {
  const inner = storeDouble()
  const first = new ObservedBlobStore(inner, () => {})
  const second = new ObservedBlobStore(first, () => {})

  assert.equal(metadataObserverForStore(inner), undefined)
  assert.equal(metadataObserverForStore(first) instanceof Function, true)
  assert.equal(metadataObserverForStore(second) instanceof Function, true)
  assert.equal(underlyingBlobStore(second), inner)
  assert.equal(underlyingBlobStore(inner), inner)
})

test("the typed wrapper forwards each blob operation and durability answer", async () => {
  const calls: unknown[][] = []
  const data = new Uint8Array([4, 2])
  const id = new Uint8Array([9])
  const inner = storeDouble({ calls, data, durable: false })
  const wrapped = new ObservedBlobStore(inner)
  const context = createContext()

  assert.equal(await wrapped.getBlob(context, id), data)
  await wrapped.setBlob(context, id, data)
  await wrapped.setBlobLocallyOnly(context, id, data)
  await wrapped.flush(context)
  assert.equal(wrapped.isBlobDurable(id), false)
  assert.deepEqual(calls.map(([operation]) => operation), ["get", "set", "local", "flush", "durable"])
})

test("ordinary stores become readable before the mirror helper returns", async () => {
  const calls: string[] = []
  const plain = storeDouble({ onSet: () => calls.push("write"), onFlush: () => calls.push("flush") })

  await ensureBlobVisibleToCloudMirror({
    blobStore: new ObservedBlobStore(plain),
    ctx: createContext(),
    blobId: new Uint8Array([1]),
    blobData: new Uint8Array([7]),
  })
  assert.deepEqual(calls, ["write", "flush"])
})

test("stores with a secondary-write port defer replication without eager writes or a flush", async () => {
  const calls: string[] = []
  const deferred = Object.assign(storeDouble({ onSet: () => calls.push("write"), onFlush: () => calls.push("flush") }), {
    setBlobAwaitingSecondary: async () => { calls.push("deferred") },
  })

  await ensureBlobVisibleToCloudMirror({
    blobStore: new ObservedBlobStore(deferred),
    ctx: createContext(),
    blobId: new Uint8Array([2]),
    blobData: new Uint8Array([8]),
  })
  assert.deepEqual(calls, ["deferred"])
})

function storeDouble(options: {
  calls?: unknown[][]
  data?: Uint8Array
  durable?: boolean
  onSet?: () => void
  onFlush?: () => void
} = {}): BlobStore<Context> {
  const calls = options.calls ?? []
  return {
    async getBlob(ctx, blobId) {
      calls.push(["get", ctx, blobId])
      return options.data
    },
    async setBlob(ctx, blobId, blobData) {
      calls.push(["set", ctx, blobId, blobData])
      options.onSet?.()
    },
    async setBlobLocallyOnly(ctx, blobId, blobData) {
      calls.push(["local", ctx, blobId, blobData])
    },
    async flush(ctx) {
      calls.push(["flush", ctx])
      options.onFlush?.()
    },
    isBlobDurable(blobId) {
      calls.push(["durable", blobId])
      return options.durable ?? true
    },
  }
}
