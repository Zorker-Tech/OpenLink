/**
 * Turning an inline image in a transcript into a file the reader can show.
 *
 * The bytes are written into the agent's own store under a name derived from the entry, and the materialization is
 * remembered so the same image is not written twice; a write that fails leaves the entry as it was.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionFromImageMime } from "../../shared/media/image-mime.ts";
export interface InlineImage {
  base64: string;
  mediaType: string;
  alt?: string;
}
export async function materializeInlineImages(
  session: { dbPath: string },
  images: readonly InlineImage[],
): Promise<Array<{ url: string; alt?: string }>> {
  if (images.length === 0) return [];
  const dir = join(dirname(session.dbPath), "xuser-attachments"),
    materialized: Array<{ url: string; alt?: string }> = [];
  for (const image of images.slice(0, 4))
    try {
      const bytes = Buffer.from(image.base64, "base64");
      if (bytes.byteLength === 0) continue;
      const hash = createHash("sha256").update(bytes).digest("hex"),
        extension = extensionFromImageMime(image.mediaType) ?? ".png",
        filePath = join(dir, `${hash}${extension}`);
      if (!existsSync(filePath)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, bytes);
      }
      materialized.push({
        url: pathToFileURL(filePath).toString(),
        ...(image.alt != null ? { alt: image.alt } : {}),
      });
    } catch {}
  return materialized;
}
