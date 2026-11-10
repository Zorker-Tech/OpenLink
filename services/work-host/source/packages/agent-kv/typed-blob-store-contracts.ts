import type { BlobStore } from "./blob-store.ts"

export const BLOB_METADATA_CALLBACK_SYMBOL = Symbol.for("slate.blobMetadataCallback")

export interface AgentBlobMetadata {
  readonly blobId: Uint8Array
  readonly blobType: unknown
}

export type AgentBlobMetadataObserver = (metadata: AgentBlobMetadata) => void

export type BlobMetadataCarrier<Context> = BlobStore<Context> & {
  [BLOB_METADATA_CALLBACK_SYMBOL]?: AgentBlobMetadataObserver
}

export interface DeferredMirrorBlobStore<Context> extends BlobStore<Context> {
  setBlobAwaitingSecondary(context: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
}
