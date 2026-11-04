import { getImageCodecs } from "./image-codecs.ts"
import { encodeWithinByteLimit } from "./image-resize-byte-budget.ts"
import {
  MAX_IMAGE_SIZE_BYTES,
  targetDimensions,
} from "./image-resize-dimensions.ts"
import { isWebp, resizeWebpBufferIfNeeded } from "./image-resize-webp.ts"

export { MAX_IMAGE_DIMENSION, MAX_IMAGE_SIZE_BYTES, MAX_WEBP_IMAGE_DIMENSION, targetDimensions } from "./image-resize-dimensions.ts"

type SupportedMimeType = "image/png" | "image/bmp" | "image/tiff" | "image/x-ms-bmp" | "image/gif" | "image/jpeg"

const MIME_BY_SOURCE: Readonly<Record<string, SupportedMimeType>> = {
  "image/png": "image/png",
  "image/bmp": "image/bmp",
  "image/tiff": "image/tiff",
  "image/x-ms-bmp": "image/x-ms-bmp",
  "image/gif": "image/gif",
  "image/jpeg": "image/jpeg",
}

function outputMimeType(image: { mime?: string }): SupportedMimeType {
  return MIME_BY_SOURCE[image.mime ?? ""] ?? "image/png"
}

function copyBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

export async function resizeImageBufferIfNeeded(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: string }> {
  if (isWebp(imageData)) return resizeWebpBufferIfNeeded(imageData)

  const codecs = await getImageCodecs()
  const image = await codecs.read(imageData)
  const mimeType = outputMimeType(image)
  const target = targetDimensions(image.width, image.height)
  if (!target.needsResize && imageData.length <= MAX_IMAGE_SIZE_BYTES) {
    return { data: copyBytes(imageData), mimeType }
  }

  const encoded = await encodeWithinByteLimit(
    image,
    target,
    async () => await image.getBuffer(mimeType),
    MAX_IMAGE_SIZE_BYTES,
  )
  return { data: copyBytes(encoded), mimeType }
}
