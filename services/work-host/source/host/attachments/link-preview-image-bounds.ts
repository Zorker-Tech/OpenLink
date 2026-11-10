import { readEncodedImageSize } from "./link-preview-image-data.ts"
import type { ImageSize, PreviewImageBounds } from "./link-preview-image-contracts.ts"

export { decodeBase64DataUrl, readEncodedImageSize } from "./link-preview-image-data.ts"
export { readIcoSize } from "./link-preview-image-ico.ts"
export type { ImageSize, PreviewImageBounds } from "./link-preview-image-contracts.ts"

export const LINK_PREVIEW_MAX_DECODE_PIXELS = 24_000_000

/** Validate decode cost before resizing; unreadable or unbounded images are not handed to the image decoder. */
export function boundPreviewImageDataUrl(
  dataUrl: string | null,
  bounds: PreviewImageBounds,
  resize: (dataUrl: string, target: { width: number } | { height: number }, encoding: unknown) => string | null,
): string | null {
  if (dataUrl === null) return null

  const size: ImageSize | null = readEncodedImageSize(dataUrl)
  if (size === null || size.width * size.height > LINK_PREVIEW_MAX_DECODE_PIXELS) return null
  if (Math.max(size.width, size.height) <= bounds.maxDimension) return dataUrl

  const target = size.width >= size.height
    ? { width: bounds.maxDimension }
    : { height: bounds.maxDimension }
  return resize(dataUrl, target, bounds.encoding) ?? dataUrl
}
