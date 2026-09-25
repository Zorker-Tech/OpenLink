/**
 * Shrinking an image before it is sent anywhere.
 *
 * Screenshots and pasted images arrive far larger than anything useful: they cost tokens, upload time
 * and memory, and a model reads a 4000-pixel-wide screenshot no better than a 1024-pixel one. Two
 * caps apply — a longest-edge dimension and a byte budget — and when the byte budget is what binds,
 * the image is scaled down step by step until it fits.
 */

import { getImageCodecs } from "./image-codecs.ts"
import { decodeWebp, encodeWebp, isWebp, readWebpDimensions } from "./webp.ts"

export const MAX_IMAGE_DIMENSION = 1024
export const MAX_WEBP_IMAGE_DIMENSION = 1280
export const MAX_IMAGE_SIZE_BYTES = 1024 * 1024
const BYTE_BUDGET_SCALE_STEP = 0.8

const toUint8Array = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

type SupportedMimeType = "image/png" | "image/bmp" | "image/tiff" | "image/x-ms-bmp" | "image/gif" | "image/jpeg"

function mimeTypeOf(image: { mime?: string }): SupportedMimeType {
  switch (image.mime) {
    case "image/png": return "image/png"
    case "image/bmp": return "image/bmp"
    case "image/tiff": return "image/tiff"
    case "image/x-ms-bmp": return "image/x-ms-bmp"
    case "image/gif": return "image/gif"
    case "image/jpeg": return "image/jpeg"
    default: return "image/png"
  }
}

/** The largest size that fits the cap, preserving the aspect ratio. */
export function targetDimensions(
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION,
): { width: number; height: number; needsResize: boolean } {
  let newWidth = width
  let newHeight = height
  if (width > height) {
    if (width > maxDimension) {
      newWidth = maxDimension
      newHeight = Math.max(1, Math.round(height * maxDimension / width))
    }
  } else if (height > maxDimension) {
    newHeight = maxDimension
    newWidth = Math.max(1, Math.round(width * maxDimension / height))
  }
  return { width: newWidth, height: newHeight, needsResize: newWidth !== width || newHeight !== height }
}

async function resizeWebp(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: "image/webp" }> {
  const dimensions = readWebpDimensions(imageData)
  const withinCap = dimensions !== undefined &&
    !targetDimensions(dimensions.width, dimensions.height, MAX_WEBP_IMAGE_DIMENSION).needsResize
  if (withinCap && imageData.length <= MAX_IMAGE_SIZE_BYTES) {
    return { data: toUint8Array(imageData), mimeType: "image/webp" }
  }
  const decoded = await decodeWebp(imageData)
  const codecs = await getImageCodecs()
  const image = codecs.fromBitmap({ data: Buffer.from(decoded.data), width: decoded.width, height: decoded.height })
  let { width, height, needsResize } = targetDimensions(image.bitmap.width, image.bitmap.height, MAX_WEBP_IMAGE_DIMENSION)
  if (needsResize) image.resize({ w: width, h: height })
  let result = await encodeWebp({ data: image.bitmap.data, width: image.bitmap.width, height: image.bitmap.height })
  while (result.length > MAX_IMAGE_SIZE_BYTES && width > 1 && height > 1) {
    width = Math.max(1, Math.round(width * BYTE_BUDGET_SCALE_STEP))
    height = Math.max(1, Math.round(height * BYTE_BUDGET_SCALE_STEP))
    image.resize({ w: width, h: height })
    result = await encodeWebp({ data: image.bitmap.data, width: image.bitmap.width, height: image.bitmap.height })
  }
  return { data: toUint8Array(result), mimeType: "image/webp" }
}

export async function resizeImageBufferIfNeeded(imageData: Buffer): Promise<{ data: Uint8Array; mimeType: string }> {
  if (isWebp(imageData)) return resizeWebp(imageData)
  const codecs = await getImageCodecs()
  const image = await codecs.read(imageData)
  const mimeType = mimeTypeOf(image)
  const dimensions = targetDimensions(image.width, image.height)
  if (!dimensions.needsResize && imageData.length <= MAX_IMAGE_SIZE_BYTES) {
    return { data: toUint8Array(imageData), mimeType }
  }
  let width = dimensions.width
  let height = dimensions.height
  if (dimensions.needsResize) image.resize({ w: width, h: height })
  let result = await image.getBuffer(mimeType)
  while (result.length > MAX_IMAGE_SIZE_BYTES && width > 1 && height > 1) {
    width = Math.max(1, Math.round(width * BYTE_BUDGET_SCALE_STEP))
    height = Math.max(1, Math.round(height * BYTE_BUDGET_SCALE_STEP))
    image.resize({ w: width, h: height })
    result = await image.getBuffer(mimeType)
  }
  return { data: toUint8Array(result), mimeType }
}
