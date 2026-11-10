import type { Context } from "../../context/context.ts"

export interface InvocationContextBlobStore {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
}

export interface ReadInvocationBlobArgs {
  readonly ctx: Context
  readonly blobId: Uint8Array
  readonly blobStore?: InvocationContextBlobStore | undefined
}

export async function readInvocationBlob({
  ctx,
  blobId,
  blobStore,
}: ReadInvocationBlobArgs): Promise<Uint8Array> {
  if (!blobStore) throw new Error("Blob store is required to hydrate invocation context blob")

  const contents = await blobStore.getBlob(ctx, blobId)
  if (!contents) throw new Error("Invocation context blob not found")

  return contents
}
