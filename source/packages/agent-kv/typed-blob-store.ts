/**
 * A blob store that also reports what it wrote.
 *
 * The metadata callback is carried on the store itself, under a symbol, because the code that needs
 * it (the mirror that ships blobs elsewhere) holds a plain `BlobStore` and cannot be handed a second
 * argument without threading it through every store implementation. Unwrapping exists for the same
 * reason: a caller that needs the underlying store (to write through it, or to reach its callback)
 * should not have to know how many wrappers are in between.
 */

import type { BlobStore } from "./blob-store.ts"

export const BLOB_METADATA_CALLBACK_SYMBOL = Symbol.for("slate.blobMetadataCallback")

export interface BlobMetadata {
  blobId: Uint8Array
  blobType: unknown
}

export type BlobMetadataCallback = (metadata: BlobMetadata) => void

type MetadataCarrier<Context> = BlobStore<Context> & {
  [BLOB_METADATA_CALLBACK_SYMBOL]?: BlobMetadataCallback
}

export function getBlobMetadataCallback<Context>(blobStore: BlobStore<Context>): BlobMetadataCallback | undefined {
  return BLOB_METADATA_CALLBACK_SYMBOL in blobStore
    ? (blobStore as MetadataCarrier<Context>)[BLOB_METADATA_CALLBACK_SYMBOL]
    : undefined
}

export function unwrapBlobStore<Context>(blobStore: BlobStore<Context>): BlobStore<Context> {
  return blobStore instanceof TypedBlobStore ? unwrapBlobStore(blobStore.getInnerBlobStore()) : blobStore
}

/** A store that can write in two stages: readable now, replicated later. */
interface WritethroughBlobStore<Context> extends BlobStore<Context> {
  setBlobAwaitingSecondary(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
}

function isWritethroughBlobStore<Context>(blobStore: BlobStore<Context>): blobStore is WritethroughBlobStore<Context> {
  return typeof (blobStore as Partial<WritethroughBlobStore<Context>>).setBlobAwaitingSecondary === "function"
}

/**
 * Writes a blob so it is readable from the cloud mirror: a store that can defer replication does so,
 * and one that cannot is written and flushed before the caller continues.
 */
export async function setBlobReadableFromCloudMirror<Context>(options: {
  blobStore: BlobStore<Context>
  ctx: Context
  blobId: Uint8Array
  blobData: Uint8Array
}): Promise<void> {
  const target = unwrapBlobStore(options.blobStore)
  if (isWritethroughBlobStore(target)) {
    await target.setBlobAwaitingSecondary(options.ctx, options.blobId, options.blobData)
    return
  }
  await options.blobStore.setBlob(options.ctx, options.blobId, options.blobData)
  await options.blobStore.flush(options.ctx)
}

export class TypedBlobStore<Context = unknown> implements BlobStore<Context> {
  readonly [BLOB_METADATA_CALLBACK_SYMBOL]: BlobMetadataCallback | undefined
  private readonly inner: BlobStore<Context>

  constructor(inner: BlobStore<Context>, onBlobMetadata?: BlobMetadataCallback) {
    this.inner = inner
    this[BLOB_METADATA_CALLBACK_SYMBOL] = onBlobMetadata
  }

  getInnerBlobStore(): BlobStore<Context> {
    return this.inner
  }

  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return this.inner.getBlob(ctx, blobId)
  }

  setBlob(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.inner.setBlob(ctx, blobId, blobData)
  }

  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void> {
    return this.inner.setBlobLocallyOnly(ctx, blobId, blobData)
  }

  flush(ctx: Context): Promise<void> {
    return this.inner.flush(ctx)
  }

  isBlobDurable(blobId: Uint8Array): boolean {
    const durable = this.inner.isBlobDurable?.(blobId)
    return durable !== undefined ? durable : true
  }
}
