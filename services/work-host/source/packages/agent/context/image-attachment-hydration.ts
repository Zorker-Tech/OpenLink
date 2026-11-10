import { getBlobId } from "../../agent-kv/blob-store.ts"
import type { Context } from "../../context/context.ts"
import type { SlateImageAttachment } from "./image-attachment-contracts.ts"

export interface SlateImageBlobStore<StoreContext = Context> {
  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>
  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>
}

export interface HydrateSlateImageArgs<StoreContext = Context> {
  readonly ctx: StoreContext
  readonly blobStore: SlateImageBlobStore<StoreContext>
  readonly image: SlateImageAttachment
}

export interface HydratedSlateImage {
  readonly image: SlateImageAttachment | undefined
  readonly imageData: Uint8Array | undefined
}

/** Resolves the image bytes and changes inline content into its durable blob reference. */
export async function hydrateSlateImage<StoreContext = Context>({
  ctx,
  blobStore,
  image,
}: HydrateSlateImageArgs<StoreContext>): Promise<HydratedSlateImage> {
  const content = image.content
  if (content === undefined) return { image: undefined, imageData: undefined }

  if (content.kind === "inline-bytes") {
    const imageBlobId = await getBlobId(content.bytes)
    await blobStore.setBlob(ctx, imageBlobId, content.bytes)
    return {
      image: { ...image, content: { kind: "stored-blob", blobId: new Uint8Array(imageBlobId) } },
      imageData: content.bytes,
    }
  }

  if (content.kind === "stored-blob") {
    const imageData = await blobStore.getBlob(ctx, content.blobId)
    if (imageData === undefined) throw new Error("Image not found")
    return { image, imageData }
  }

  if (content.kind === "blob-with-bytes") {
    await blobStore.setBlobLocallyOnly(ctx, content.blobId, content.bytes)
    return {
      image: { ...image, content: { kind: "stored-blob", blobId: new Uint8Array(content.blobId) } },
      imageData: content.bytes,
    }
  }

  throw new Error("Image still references an unresolved prompt upload.")
}
