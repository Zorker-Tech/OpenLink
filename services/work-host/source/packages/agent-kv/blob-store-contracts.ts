export interface BlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
  /** Makes bytes readable locally without waiting for replication to complete. */
  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, blobData: Uint8Array): Promise<void>
  flush(ctx: Context): Promise<void>
  isBlobDurable?(blobId: Uint8Array): boolean
}

export function isBlobDurable(blobStore: BlobStore, blobId: Uint8Array): boolean {
  const durable = blobStore.isBlobDurable?.(blobId)
  return durable !== undefined ? durable : true
}
