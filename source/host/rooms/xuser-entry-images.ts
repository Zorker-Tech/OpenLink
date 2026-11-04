import { MAX_INLINE_IMAGES_PER_ENTRY, type InlineImage } from "./xuser-wire-normalization.ts";
import { SLATE_SHARED_ROOM_IMAGE_BYTES_MAX, type XuserEntryPublisherHost } from "./xuser-entry-publisher-contracts.ts";

export async function inlineRoomImages(
  host: XuserEntryPublisherHost,
  images?: readonly { url: string; alt?: string }[],
): Promise<InlineImage[]> {
  if (images == null || images.length === 0) return [];

  const inlined: InlineImage[] = [];
  let totalBytes = 0;
  for (const image of images.slice(0, MAX_INLINE_IMAGES_PER_ENTRY)) {
    try {
      const attachment = await host.resolveAttachment(image.url);
      if (attachment === null) continue;
      if (totalBytes + attachment.data.byteLength > SLATE_SHARED_ROOM_IMAGE_BYTES_MAX) continue;
      if (!attachment.mimeType.startsWith("image/")) continue;

      totalBytes += attachment.data.byteLength;
      inlined.push({
        base64: Buffer.from(attachment.data).toString("base64"),
        mediaType: attachment.mimeType,
        ...(image.alt != null && image.alt.length > 0 ? { alt: image.alt } : {}),
      });
    } catch {
      // An attachment that cannot be resolved does not block the rest of the entry.
    }
  }
  return inlined;
}
