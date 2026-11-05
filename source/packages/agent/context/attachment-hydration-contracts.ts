export interface AttachmentContentStore<Context = unknown> {
  getBlob(context: Context, blobId: Uint8Array): Promise<Uint8Array | undefined>
  setBlob(context: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>
  setBlobLocallyOnly(context: Context, blobId: Uint8Array, data: Uint8Array): Promise<void>
}

export type AttachmentContentReference =
  | { readonly kind: "inline-bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "stored-blob"; readonly blobId: Uint8Array }
  | { readonly kind: "blob-with-bytes"; readonly blobId: Uint8Array; readonly bytes: Uint8Array }
  | { readonly kind: "unresolved-upload-reference"; readonly uploadId: string }

export interface HydrateAttachmentContentInput<Context, Attachment> {
  readonly ctx: Context
  readonly blobStore: AttachmentContentStore<Context>
  readonly attachment: Attachment
  readonly contentReference: AttachmentContentReference | undefined
  readonly missingBlobError: string
  readonly maxBytes?: number
  readonly sizeErrorLabel: string
  readonly withBlobId: (blobId: Uint8Array) => Attachment
}

export interface HydratedAttachmentContent<Attachment> {
  readonly data: Uint8Array | undefined
  readonly attachment: Attachment | undefined
}
