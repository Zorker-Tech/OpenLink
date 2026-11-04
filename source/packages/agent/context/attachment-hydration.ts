import { getBlobId } from "../../agent-kv/blob-store.ts"
import { enforceAttachmentByteLimit } from "./attachment-hydration-policy.ts"
import type {
  AttachmentContentReference,
  AttachmentContentStore,
  HydrateAttachmentContentInput,
  HydratedAttachmentContent,
} from "./attachment-hydration-contracts.ts"

export { enforceAttachmentByteLimit } from "./attachment-hydration-policy.ts"
export type {
  AttachmentContentReference,
  AttachmentContentStore,
  HydrateAttachmentContentInput,
  HydratedAttachmentContent,
} from "./attachment-hydration-contracts.ts"

/** Produces readable bytes and the matching attachment reference from the source carried in a selection. */
export async function hydrateAttachmentContent<Context, Attachment>(
  request: HydrateAttachmentContentInput<Context, Attachment>,
): Promise<HydratedAttachmentContent<Attachment>> {
  const { ctx, blobStore, attachment, contentReference, missingBlobError, maxBytes, sizeErrorLabel, withBlobId } = request

  switch (contentReference?.kind) {
    case "inline-bytes": {
      const data = contentReference.bytes
      enforceAttachmentByteLimit({ data, maxBytes, label: sizeErrorLabel })
      const blobId = await getBlobId(data)
      await blobStore.setBlob(ctx, blobId, data)
      return { data, attachment: withBlobId(new Uint8Array(blobId)) }
    }
    case "stored-blob": {
      const data = await blobStore.getBlob(ctx, contentReference.blobId)
      if (data === undefined) throw new Error(missingBlobError)
      enforceAttachmentByteLimit({ data, maxBytes, label: sizeErrorLabel })
      return { data, attachment }
    }
    case "blob-with-bytes": {
      enforceAttachmentByteLimit({ data: contentReference.bytes, maxBytes, label: sizeErrorLabel })
      await blobStore.setBlobLocallyOnly(ctx, contentReference.blobId, contentReference.bytes)
      return { data: contentReference.bytes, attachment: withBlobId(new Uint8Array(contentReference.blobId)) }
    }
    case "unresolved-upload-reference":
      throw new Error(`${sizeErrorLabel} still references an unresolved prompt upload.`)
    default:
      return { data: undefined, attachment: undefined }
  }
}
