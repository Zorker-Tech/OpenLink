import { promises as fs } from "node:fs"
import { basename } from "node:path"
import { reanchorSlatePath } from "../host-paths.ts"
import { imageMimeFromPath, videoMimeFromPath } from "../../shared/media/image-mime.ts"
import {
  CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES,
  GENERIC_BINARY_MIME,
  type ChannelAttachmentFilePorts,
  type ResolvedChannelAttachment,
} from "./channel-attachment-contracts.ts"

export async function uploadLocalChannelAttachment(
  sourcePath: string,
  ports: ChannelAttachmentFilePorts,
): Promise<ResolvedChannelAttachment | null> {
  const anchoredPath = (ports.reanchor ?? reanchorSlatePath)(sourcePath)
  let fileSize: number
  try {
    const details = await (ports.stat ?? fs.stat)(anchoredPath)
    if (!details.isFile()) return null
    fileSize = details.size
  } catch {
    return null
  }
  if (fileSize === 0 || fileSize > CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES) return null

  let content: Buffer
  try {
    content = await (ports.readFile ?? fs.readFile)(anchoredPath)
  } catch {
    return null
  }

  const imageMime = imageMimeFromPath(anchoredPath)
  return {
    transport: "upload",
    isImage: imageMime != null,
    bytes: new Uint8Array(content),
    filename: basename(anchoredPath),
    mime: imageMime ?? videoMimeFromPath(anchoredPath) ?? GENERIC_BINARY_MIME,
  }
}
