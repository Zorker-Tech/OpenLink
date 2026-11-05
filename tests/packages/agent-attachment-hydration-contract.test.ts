import assert from "node:assert/strict"
import { test } from "node:test"

import { getBlobId } from "../../source/packages/agent-kv/blob-store.ts"
import {
  hydrateAttachmentContent,
  type AttachmentContentStore,
} from "../../source/packages/agent/context/attachment-hydration.ts"

function storeWith(initial = new Map<string, Uint8Array>()) {
  const calls: unknown[][] = []
  const byId = (id: Uint8Array) => Array.from(id).join(".")
  const store: AttachmentContentStore<string> = {
    async getBlob(ctx, id) { calls.push(["get", ctx, byId(id)]); return initial.get(byId(id)) },
    async setBlob(ctx, id, data) { calls.push(["set", ctx, byId(id), data]); initial.set(byId(id), data) },
    async setBlobLocallyOnly(ctx, id, data) { calls.push(["local", ctx, byId(id), data]); initial.set(byId(id), data) },
  }
  return { store, calls, initial }
}

function request(store: AttachmentContentStore<string>, contentReference: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ctx: "ctx",
    blobStore: store,
    attachment: { name: "file" },
    contentReference,
    missingBlobError: "missing bytes",
    sizeErrorLabel: "Attachment",
    withBlobId: (blobId: Uint8Array) => ({ name: "file", blobId }),
    ...overrides,
  } as never
}

test("inline bytes are size-checked, addressed and stored normally", async () => {
  const world = storeWith()
  const bytes = new Uint8Array([1, 2, 3])
  const result = await hydrateAttachmentContent(request(world.store, { kind: "inline-bytes", bytes }, { maxBytes: 3 }))
  const blobId = await getBlobId(bytes)

  assert.deepEqual(result.data, bytes)
  assert.deepEqual(result.attachment, { name: "file", blobId })
  assert.deepEqual(world.calls.map(([kind]) => kind), ["set"])
})

test("a stored blob is fetched, size-checked and returned with its original attachment", async () => {
  const id = new Uint8Array([8])
  const bytes = new Uint8Array([4, 5])
  const world = storeWith(new Map([["8", bytes]]))
  const attachment = { name: "original" }
  const result = await hydrateAttachmentContent(request(world.store, { kind: "stored-blob", blobId: id }, { attachment, maxBytes: 2 }))

  assert.equal(result.data, bytes)
  assert.equal(result.attachment, attachment)
  assert.deepEqual(world.calls, [["get", "ctx", "8"]])
})

test("bytes paired with an existing id are stored locally only", async () => {
  const world = storeWith()
  const id = new Uint8Array([3, 1])
  const bytes = new Uint8Array([9])
  const result = await hydrateAttachmentContent(request(world.store, {
    kind: "blob-with-bytes",
    blobId: id,
    bytes,
  }))

  assert.deepEqual(result.data, bytes)
  assert.deepEqual(result.attachment, { name: "file", blobId: id })
  assert.deepEqual(world.calls.map(([kind]) => kind), ["local"])
})

test("size limits are checked before writes and after stored reads", async () => {
  const world = storeWith(new Map([["5", new Uint8Array(4)]]))
  await assert.rejects(hydrateAttachmentContent(request(world.store, { kind: "inline-bytes", bytes: new Uint8Array(4) }, { maxBytes: 3 })), /Attachment exceeds maximum size/)
  await assert.rejects(hydrateAttachmentContent(request(world.store, {
    kind: "blob-with-bytes",
    blobId: new Uint8Array([5]),
    bytes: new Uint8Array(4),
  }, { maxBytes: 3 })), /Attachment exceeds maximum size/)
  await assert.rejects(hydrateAttachmentContent(request(world.store, { kind: "stored-blob", blobId: new Uint8Array([5]) }, { maxBytes: 3 })), /Attachment exceeds maximum size/)
  assert.deepEqual(world.calls.map(([kind]) => kind), ["get"])
})

test("missing bytes and unresolved upload references are errors, while no source is an empty result", async () => {
  const world = storeWith()
  await assert.rejects(hydrateAttachmentContent(request(world.store, { kind: "stored-blob", blobId: new Uint8Array([9]) })), /missing bytes/)
  await assert.rejects(hydrateAttachmentContent(request(world.store, { kind: "unresolved-upload-reference", uploadId: "upload-1" })), /unresolved prompt upload/)
  assert.deepEqual(await hydrateAttachmentContent(request(world.store, undefined)), { data: undefined, attachment: undefined })
})
