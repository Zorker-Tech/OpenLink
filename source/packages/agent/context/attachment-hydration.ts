/**
 * Getting an attachment's bytes, whichever way it arrived.
 *
 * An attachment can carry its bytes, name a blob the platform stored, carry both, or reference an upload
 * that has not been resolved yet. All four end in the same place — bytes in hand and an attachment that
 * names a blob — and the differences are about where the bytes are written: bytes that arrived with an id
 * came from somewhere that already published them and are stored locally only, while bytes that arrived
 * alone are stored normally.
 *
 * The size limit is checked before anything is written, and it is checked again for bytes that came from
 * the store: a blob written before the limit changed is still too large to send.
 */

import { getBlobId } from "../../agent-kv/blob-store.ts"

export interface AttachmentBlobStore<Context = unknown> {
  getBlob(ctx: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(ctx: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>
  setBlobLocallyOnly(ctx: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>
}

export type AttachmentDataOrBlobId =
  | { case: "data"; value: Uint8Array }
  | { case: "blobId"; value: Uint8Array }
  | { case: "blobIdWithData"; value: { blobId: Uint8Array; data: Uint8Array } }
  | { case: "promptUploadRef"; value: unknown }
  | { case: undefined; value?: undefined }

export interface HydrateSelectedAttachmentDataArgs<Context, Attachment> {
  readonly ctx: Context
  readonly blobStore: AttachmentBlobStore<Context>
  readonly attachment: Attachment
  readonly dataOrBlobId: AttachmentDataOrBlobId | undefined
  readonly missingBlobError: string
  readonly maxBytes?: number
  readonly sizeErrorLabel: string
  readonly withBlobId: (blobId: Uint8Array) => Attachment
}

function assertAttachmentWithinMaxBytes(args: {
  readonly data: Uint8Array
  readonly maxBytes: number | undefined
  readonly label: string
}): void {
  const { data, maxBytes, label } = args
  if (maxBytes !== undefined && data.length > maxBytes) {
    throw new Error(`${label} exceeds maximum size of ${maxBytes} bytes (${Math.round(maxBytes / 1024 / 1024)}MB)`)
  }
}

export async function hydrateSelectedAttachmentData<Context, Attachment>(
  args: HydrateSelectedAttachmentDataArgs<Context, Attachment>,
): Promise<{ data: Uint8Array | undefined; processedAttachment: Attachment | undefined }> {
  const { ctx, blobStore, attachment, dataOrBlobId, missingBlobError, maxBytes, sizeErrorLabel, withBlobId } = args
  if (dataOrBlobId?.case === "data") {
    const data = dataOrBlobId.value
    assertAttachmentWithinMaxBytes({ data, maxBytes, label: sizeErrorLabel })
    const blobId = await getBlobId(data)
    await blobStore.setBlob(ctx, blobId, data)
    return { data, processedAttachment: withBlobId(new Uint8Array(blobId)) }
  }
  if (dataOrBlobId?.case === "blobId") {
    const data = await blobStore.getBlob(ctx, dataOrBlobId.value)
    if (!data) throw new Error(missingBlobError)
    assertAttachmentWithinMaxBytes({ data, maxBytes, label: sizeErrorLabel })
    return { data, processedAttachment: attachment }
  }
  if (dataOrBlobId?.case === "blobIdWithData") {
    const { blobId, data } = dataOrBlobId.value
    assertAttachmentWithinMaxBytes({ data, maxBytes, label: sizeErrorLabel })
    await blobStore.setBlobLocallyOnly(ctx, blobId, data)
    return { data, processedAttachment: withBlobId(new Uint8Array(blobId)) }
  }
  if (dataOrBlobId?.case === "promptUploadRef") {
    throw new Error(`${sizeErrorLabel} still references an unresolved prompt upload.`)
  }
  return { data: undefined, processedAttachment: undefined }
}
