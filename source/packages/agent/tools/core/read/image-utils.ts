/**
 * What kind of image a file is, for the tools that have to send it somewhere.
 *
 * The bytes are asked first, because they are the truth: a file named `.png` that is really a JPEG would
 * be sent as the wrong type, and a provider that rejects it gives an error nobody can act on. The name is
 * the fallback for the formats the byte detector does not know, and a short list of extensions covers the
 * ones it cannot see at all — a name that claims to be an image is better than no type, since the reader
 * will decide for itself whether it can decode it.
 */

import imageType from "image-type"
import mimeTypesModule from "mime-types"

interface MimeTypesModule {
  lookup(path: string): string | false
}

const mimeTypes = mimeTypesModule as MimeTypesModule

const EXTENSION_FALLBACKS: Readonly<Record<string, string>> = {
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
}

export function detectImageMimeType(bytes: Uint8Array, filePath?: string): string | undefined {
  const result = imageType(bytes)
  if (result?.mime) return result.mime
  if (filePath) {
    const mimeType = mimeTypes.lookup(filePath)
    if (mimeType && typeof mimeType === "string" && mimeType.startsWith("image/")) return mimeType
    const extension = filePath.toLowerCase().match(/\.([^.]+)$/)?.[1]
    if (extension) {
      const fallback = EXTENSION_FALLBACKS[extension]
      if (fallback) return fallback
    }
  }
  return undefined
}
