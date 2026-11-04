import type { BlobStore } from "./blob-store.ts"
import { ObservedBlobStore } from "./observed-blob-store.ts"
import { BLOB_METADATA_CALLBACK_SYMBOL, type AgentBlobMetadataObserver, type BlobMetadataCarrier } from "./typed-blob-store-contracts.ts"

export function metadataObserverForStore<Context>(store: BlobStore<Context>): AgentBlobMetadataObserver | undefined {
  return BLOB_METADATA_CALLBACK_SYMBOL in store
    ? (store as BlobMetadataCarrier<Context>)[BLOB_METADATA_CALLBACK_SYMBOL]
    : undefined
}

export function underlyingBlobStore<Context>(store: BlobStore<Context>): BlobStore<Context> {
  return store instanceof ObservedBlobStore ? underlyingBlobStore(store.getSource()) : store
}
