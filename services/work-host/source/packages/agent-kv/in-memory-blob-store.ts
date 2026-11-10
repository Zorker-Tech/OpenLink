import type { Context as OperationContext } from "../context/context.ts"
import { createHistogram } from "../metrics/index.ts"
import { toHex } from "./serde.ts"
import type { BlobStore } from "./blob-store-contracts.ts"

const readLatency = createHistogram("agent_kv.in_memory.get_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore getBlob operations in milliseconds",
})
const writeLatency = createHistogram("agent_kv.in_memory.set_blob.duration_ms", {
  description: "Duration of InMemoryBlobStore setBlob operations in milliseconds",
})

function timed<T>(action: () => T, observe: (durationMs: number) => void): Promise<T> {
  const startedAt = performance.now()
  try {
    return Promise.resolve(action())
  } finally {
    observe(performance.now() - startedAt)
  }
}

/** A short-lived byte store for tests and operations that do not need persistence. */
export class InMemoryBlobStore<StoreContext extends OperationContext = OperationContext>
  implements BlobStore<StoreContext> {
  private readonly blobs = new Map<string, Uint8Array>()

  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return timed(
      () => this.blobs.get(toHex(blobId)),
      durationMs => readLatency.histogram(ctx, durationMs),
    )
  }

  setBlob(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return timed(
      () => { this.blobs.set(toHex(blobId), blobData) },
      durationMs => writeLatency.histogram(ctx, durationMs),
    )
  }

  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.setBlob(ctx, blobId, blobData)
  }

  flush(_ctx: StoreContext): Promise<void> {
    return Promise.resolve()
  }
}
