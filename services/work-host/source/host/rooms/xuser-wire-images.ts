import type { InlineImage } from "./xuser-wire-contracts.ts";
import { wireRecord } from "./xuser-wire-records.ts";

export const MAX_INLINE_IMAGES_PER_ENTRY = 4;

export function normalizeInlineImages(raw: unknown): InlineImage[] {
  if (!Array.isArray(raw)) return [];
  const accepted: InlineImage[] = [];
  for (const candidate of raw.slice(0, MAX_INLINE_IMAGES_PER_ENTRY)) {
    const image = wireRecord(candidate);
    if (image == null || typeof image.base64 !== "string" || image.base64.length === 0) continue;
    const mediaType = typeof image.mediaType === "string" && image.mediaType.startsWith("image/")
      ? image.mediaType
      : "image/png";
    accepted.push({
      base64: image.base64,
      mediaType,
      ...(typeof image.alt === "string" && image.alt.length > 0 ? { alt: image.alt } : {}),
    });
  }
  return accepted;
}
