/** Resolve an image type from its bytes first, then from a trusted filename suffix. */

import imageType from "image-type";
import mimeTypesModule from "mime-types";

interface MimeTypesModule {
  lookup(path: string): string | false
}

const mimeTypes = mimeTypesModule as MimeTypesModule

const LAST_RESORT_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

function imageTypeFromPath(filePath: string): string | undefined {
  const declared = mimeTypes.lookup(filePath);
  if (typeof declared === "string" && declared.startsWith("image/")) return declared;

  const extension = filePath.toLowerCase().match(/\.([^.]+)$/)?.[1];
  return extension === undefined ? undefined : LAST_RESORT_TYPES[extension];
}

export function detectImageMimeType(bytes: Uint8Array, filePath?: string): string | undefined {
  const signatureType = imageType(bytes)?.mime;
  if (signatureType) return signatureType;
  if (filePath === undefined || filePath.length === 0) return undefined;
  return imageTypeFromPath(filePath);
}
