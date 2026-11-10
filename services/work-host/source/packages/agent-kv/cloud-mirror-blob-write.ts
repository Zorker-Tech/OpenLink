import type { BlobStore } from "./blob-store.ts"
import { underlyingBlobStore } from "./blob-store-observation.ts"
import type { DeferredMirrorBlobStore } from "./typed-blob-store-contracts.ts"

function supportsDeferredMirrorWrite<Context>(store: BlobStore<Context>): store is DeferredMirrorBlobStore<Context> {
  return typeof (store as Partial<DeferredMirrorBlobStore<Context>>).setBlobAwaitingSecondary === "function"
}

/** Makes data readable by a mirror before returning, deferring durable replication when the store supports it. */
export async function ensureBlobVisibleToCloudMirror<Context>(input: {
  readonly blobStore: BlobStore<Context>
  readonly ctx: Context
  readonly blobId: Uint8Array
  readonly blobData: Uint8Array
}): Promise<void> {
  const storage = underlyingBlobStore(input.blobStore)
  if (supportsDeferredMirrorWrite(storage)) {
    await storage.setBlobAwaitingSecondary(input.ctx, input.blobId, input.blobData)
    return
  }
  await input.blobStore.setBlob(input.ctx, input.blobId, input.blobData)
  await input.blobStore.flush(input.ctx)
}
