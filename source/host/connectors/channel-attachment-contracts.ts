import type { promises as fs } from "node:fs"

export const CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
export const GENERIC_BINARY_MIME = "application/octet-stream"

export type ResolvedChannelAttachment =
  | { readonly transport: "url"; readonly isImage: boolean; readonly url: string }
  | { readonly transport: "upload"; readonly isImage: boolean; readonly bytes: Uint8Array; readonly filename: string; readonly mime: string }

export interface ChannelAttachmentFilePorts {
  readonly reanchor?: (path: string) => string
  readonly stat?: typeof fs.stat
  readonly readFile?: typeof fs.readFile
}
