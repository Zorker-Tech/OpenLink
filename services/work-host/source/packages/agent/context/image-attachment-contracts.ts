/** The bytes and location decision for one image attached to a turn. */
export type SlateImageContent =
  | { readonly kind: "inline-bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "stored-blob"; readonly blobId: Uint8Array }
  | { readonly kind: "blob-with-bytes"; readonly blobId: Uint8Array; readonly bytes: Uint8Array }
  | { readonly kind: "unresolved-upload"; readonly uploadId: string }

/** Product-owned image attachment data consumed by Slate's context pipeline. */
export interface SlateImageAttachment {
  readonly id: string
  readonly sourcePath: string
  readonly mediaType: string
  readonly dimensions?: { readonly width: number; readonly height: number }
  readonly content?: SlateImageContent
}
