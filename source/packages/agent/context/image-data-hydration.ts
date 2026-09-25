/**
 * Getting an attached image's bytes, and settling where they live.
 *
 * An image arrives one of three ways: as bytes the platform should store, as a reference to bytes already
 * stored, or as both at once — bytes plus the id they are stored under, from a surface that had them in
 * hand. Each case ends the same way, with the attachment referring to a blob id and the bytes returned,
 * which is what everything downstream expects.
 *
 * The two storage calls are deliberately different: bytes that arrived with an id are written locally
 * only, because the id came from somewhere that already published them, while bytes that arrived on their
 * own are stored normally. An upload reference that was never resolved is an error: it means the upload
 * did not finish, and continuing would send an image that is not there.
 */

import { getBlobId } from "../../agent-kv/blob-store.ts"
import type { Context } from "../../context/context.ts"
import {
  SelectedImage,
  type SelectedImage as SelectedImageValue,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface SelectedImageBlobStore<StoreContext = Context> {
  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>
  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>
}

export interface HydrateSelectedImageDataArgs<StoreContext = Context> {
  readonly ctx: StoreContext
  readonly blobStore: SelectedImageBlobStore<StoreContext>
  readonly selectedImage: SelectedImageValue
}

export interface HydratedSelectedImageData {
  readonly selectedImage: SelectedImageValue | undefined
  readonly imageData: Uint8Array | undefined
}

export async function hydrateSelectedImageData<StoreContext = Context>({
  ctx,
  blobStore,
  selectedImage,
}: HydrateSelectedImageDataArgs<StoreContext>): Promise<HydratedSelectedImageData> {
  let imageData: Uint8Array | undefined
  let processedSelectedImage: SelectedImageValue | undefined
  if (selectedImage.dataOrBlobId?.case === "data") {
    imageData = selectedImage.dataOrBlobId.value
    const imageBlobId = await getBlobId(imageData)
    await blobStore.setBlob(ctx, imageBlobId, imageData)
    processedSelectedImage = new SelectedImage({
      ...selectedImage,
      dataOrBlobId: { case: "blobId", value: new Uint8Array(imageBlobId) },
    })
  } else if (selectedImage.dataOrBlobId?.case === "blobId") {
    const imageBlobId = selectedImage.dataOrBlobId.value
    imageData = await blobStore.getBlob(ctx, imageBlobId)
    if (!imageData) throw new Error("Image not found")
    processedSelectedImage = selectedImage
  } else if (selectedImage.dataOrBlobId?.case === "blobIdWithData") {
    const blobIdWithData = selectedImage.dataOrBlobId.value
    imageData = blobIdWithData.data
    await blobStore.setBlobLocallyOnly(ctx, blobIdWithData.blobId, imageData)
    processedSelectedImage = new SelectedImage({
      ...selectedImage,
      dataOrBlobId: { case: "blobId", value: new Uint8Array(blobIdWithData.blobId) },
    })
  } else if (selectedImage.dataOrBlobId?.case === "promptUploadRef") {
    throw new Error("Image still references an unresolved prompt upload.")
  }
  return { selectedImage: processedSelectedImage, imageData }
}
