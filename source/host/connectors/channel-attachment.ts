import {
  classifyChannelAttachmentAddress,
  isChannelImageAddress,
  localPathFromChannelAddress,
} from "./channel-attachment-address.ts"
import {
  CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES,
  GENERIC_BINARY_MIME,
  type ChannelAttachmentFilePorts,
  type ResolvedChannelAttachment,
} from "./channel-attachment-contracts.ts"
import { uploadLocalChannelAttachment } from "./channel-attachment-file.ts"

export { CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES, GENERIC_BINARY_MIME }
export type { ResolvedChannelAttachment, ChannelAttachmentFilePorts }
export { localPathFromChannelAddress as toLocalChannelAttachmentPath }
export { isChannelImageAddress as urlLooksLikeImage }

export async function resolveChannelAttachment(
  input: unknown,
  ports: ChannelAttachmentFilePorts = {},
): Promise<ResolvedChannelAttachment | null> {
  if (typeof input !== "string" || input.length === 0) return null
  const address = classifyChannelAttachmentAddress(input)
  if (address === null) return null
  if (address.kind === "remote") {
    return { transport: "url", isImage: address.image, url: input }
  }
  return uploadLocalChannelAttachment(address.path, ports)
}
