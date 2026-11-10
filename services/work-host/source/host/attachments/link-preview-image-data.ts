import { gifSize, jpegSize, pngSize, webpOrHeicSize } from "../../shared/media/image-dimensions.ts"
import type { ImageSize } from "./link-preview-image-contracts.ts"
import { readIcoSize } from "./link-preview-image-ico.ts"

/** Decode only a data URL that explicitly carries base64 bytes. */
export function decodeBase64DataUrl(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith("data:")) return null
  const comma = dataUrl.indexOf(",")
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(";base64")) return null
  return Buffer.from(dataUrl.slice(comma + 1), "base64")
}

const dimensionReaders = [pngSize, jpegSize, gifSize, readIcoSize, webpOrHeicSize]

export function readEncodedImageSize(dataUrl: string): ImageSize | null {
  const bytes = decodeBase64DataUrl(dataUrl)
  if (bytes === null) return null

  for (const readSize of dimensionReaders) {
    const size = readSize(bytes)
    if (size !== null && size.width > 0 && size.height > 0) return size
  }
  return null
}
