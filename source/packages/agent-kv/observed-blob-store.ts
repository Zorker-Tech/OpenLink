import type { BlobStore } from "./blob-store.ts"
import { BLOB_METADATA_CALLBACK_SYMBOL, type AgentBlobMetadataObserver } from "./typed-blob-store-contracts.ts"

/** Adds an optional metadata observer without changing the wrapped store's read or write behavior. */
export class ObservedBlobStore<Context = unknown> implements BlobStore<Context> {
  readonly [BLOB_METADATA_CALLBACK_SYMBOL]: AgentBlobMetadataObserver | undefined
  private readonly source: BlobStore<Context>

  constructor(source: BlobStore<Context>, observeMetadata?: AgentBlobMetadataObserver) {
    this.source = source
    this[BLOB_METADATA_CALLBACK_SYMBOL] = observeMetadata
  }

  getSource(): BlobStore<Context> {
    return this.source
  }

  getBlob(context: Context, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return this.source.getBlob(context, blobId)
  }

  setBlob(context: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.source.setBlob(context, blobId, blobData)
  }

  setBlobLocallyOnly(context: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.source.setBlobLocallyOnly(context, blobId, blobData)
  }

  flush(context: Context): Promise<void> {
    return this.source.flush(context)
  }

  isBlobDurable(blobId: Uint8Array): boolean {
    return this.source.isBlobDurable?.(blobId) ?? true
  }
}
