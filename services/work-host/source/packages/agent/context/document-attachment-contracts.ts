import type { AttachmentContentReference } from "./attachment-hydration-contracts.ts"

export interface SlateDocumentAttachment {
  readonly uuid: string
  readonly filename: string
  readonly mimeType: string
  readonly path: string
  readonly content: AttachmentContentReference | undefined
}
