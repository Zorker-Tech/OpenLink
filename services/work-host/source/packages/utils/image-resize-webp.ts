import { getImageCodecs } from "./image-codecs.ts"
import { decodeWebp, encodeWebp, isWebp, webpSize } from "./webp.ts"
import { encodeWithinByteLimit } from "./image-resize-byte-budget.ts"
import { MAX_IMAGE_SIZE_BYTES, MAX_WEBP_IMAGE_DIMENSION, targetDimensions } from "./image-resize-dimensions.ts"

const asUint8Array = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

export async function resizeWebpBufferIfNeeded(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: "image/webp" }> {
  const headerSize = webpSize(imageData)
  const isSmallEnough = headerSize !== undefined &&
    !targetDimensions(headerSize.width, headerSize.height, MAX_WEBP_IMAGE_DIMENSION).needsResize
  if (isSmallEnough && imageData.length <= MAX_IMAGE_SIZE_BYTES) {
    return { data: asUint8Array(imageData), mimeType: "image/webp" }
  }

  const decoded = await decodeWebp(imageData)
  const codecs = await getImageCodecs()
  const image = codecs.fromBitmap({ data: Buffer.from(decoded.data), width: decoded.width, height: decoded.height })
  const target = targetDimensions(image.bitmap.width, image.bitmap.height, MAX_WEBP_IMAGE_DIMENSION)
  const encoded = await encodeWithinByteLimit(
    image,
    target,
    async () => await encodeWebp({ data: image.bitmap.data, width: image.bitmap.width, height: image.bitmap.height }),
    MAX_IMAGE_SIZE_BYTES,
  )
  return { data: asUint8Array(encoded), mimeType: "image/webp" }
}

export { isWebp }
