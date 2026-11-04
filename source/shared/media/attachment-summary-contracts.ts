import type { SlateAttachmentKind } from "./attachments.ts"

export type AttachmentClassification = Exclude<SlateAttachmentKind, "file">

export interface AttachmentClassificationSource {
  readonly mimeType?: string | null
  readonly fileName?: string | null
  readonly urlOrPath?: string | null
}
