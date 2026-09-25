/**
 * The blob store: content-addressed bytes, and an in-memory one for tests and short-lived work.
 *
 * A blob is identified by the hash of its bytes, so writing the same value twice writes one blob and
 * a reader can trust that an id means one thing. Stores differ in where they keep the bytes (memory,
 * disk, a synced store) and in whether a write has reached durability yet — `isBlobDurable` is how a
 * caller finds out, and a store that cannot say is assumed durable.
 */

import type { Context as OperationContext } from "../context/context.ts"
import { createHistogram } from "../metrics/index.ts"
import { toHex } from "./serde.ts"

export interface BlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
  /** Writes without waiting for the store to replicate: the bytes are readable, not yet safe. */
  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
  flush(ctx: Context): Promise<void>
  isBlobDurable?(blobId: Uint8Array): boolean
}

export function isBlobDurable(blobStore: BlobStore, blobId: Uint8Array): boolean {
  const durable = blobStore.isBlobDurable?.(blobId)
  return durable !== undefined ? durable : true
}

/** A view over the bytes, copying only when the buffer is shared with another thread. */
export function toUint8Array(value: Uint8Array): Uint8Array {
  return typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/** The content address of a blob: SHA-256 over a copy, so a caller's later mutation cannot change it. */
export async function getBlobId(blobData: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const view = toUint8Array(blobData)
  const owned = new Uint8Array(view.byteLength)
  owned.set(view)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer))
}

const getBlobLatency = createHistogram("agent_kv.in_memory.get_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore getBlob operations in milliseconds",
})
const setBlobLatency = createHistogram("agent_kv.in_memory.set_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore setBlob operations in milliseconds",
})

export class InMemoryBlobStore<StoreContext extends OperationContext = OperationContext>
  implements BlobStore<StoreContext> {
  private readonly blobs = new Map<string, Uint8Array>()

  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    const started = performance.now()
    try {
      return Promise.resolve(this.blobs.get(toHex(blobId)))
    } finally {
      getBlobLatency.histogram(ctx, performance.now() - started)
    }
  }

  setBlob(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    const started = performance.now()
    try {
      this.blobs.set(toHex(blobId), blobData)
      return Promise.resolve()
    } finally {
      setBlobLatency.histogram(ctx, performance.now() - started)
    }
  }

  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.setBlob(ctx, blobId, blobData)
  }

  flush(_ctx: StoreContext): Promise<void> {
    return Promise.resolve()
  }
}
