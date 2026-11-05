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

import type { Context } from "../../../packages/context/context.ts"
import type { SelectedImage as SelectedImageValue } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { SlateImageBlobStore } from "../../../packages/agent/context/image-attachment-hydration.ts"
import { hydrateSlateImage } from "../../../packages/agent/context/image-attachment-hydration.ts"
import { fromInteropSelectedImage, toInteropSelectedImage } from "./selected-context-entry-adapter.ts"

export type SelectedImageBlobStore<StoreContext = Context> = SlateImageBlobStore<StoreContext>

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
  const result = await hydrateSlateImage({
    ctx,
    blobStore,
    image: fromInteropSelectedImage(selectedImage),
  })
  return {
    selectedImage: result.image === undefined ? undefined : toInteropSelectedImage(result.image),
    imageData: result.imageData,
  }
}
