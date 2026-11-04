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
  readonly base64: string
  readonly mediaType: string
  readonly alt?: string | undefined
}

export interface MaterializedInlineImage {
  readonly url: string
  readonly alt?: string | undefined
}

const MAX_IMAGES_PER_ENTRY = 4
const DEFAULT_IMAGE_EXTENSION = ".png"

export async function materializeInlineImages(
  session: { readonly dbPath: string },
  images: readonly InlineImage[],
): Promise<MaterializedInlineImage[]> {
  if (images.length === 0) return []

  const directory = attachmentDirectoryFor(session.dbPath)
  const saved: MaterializedInlineImage[] = []
  for (const image of images.slice(0, MAX_IMAGES_PER_ENTRY)) {
    const result = persistOneImage(directory, image)
    if (result !== undefined) saved.push(result)
  }
  return saved
}

function attachmentDirectoryFor(databasePath: string): string {
  return join(dirname(databasePath), "xuser-attachments")
}

function persistOneImage(directory: string, image: InlineImage): MaterializedInlineImage | undefined {
  try {
    const bytes = Buffer.from(image.base64, "base64")
    if (bytes.byteLength === 0) return undefined

    const filePath = imagePathFor(directory, image.mediaType, bytes)
    writeUnlessPresent(directory, filePath, bytes)
    return {
      url: pathToFileURL(filePath).toString(),
      ...(image.alt != null ? { alt: image.alt } : {}),
    }
  } catch {
    return undefined
  }
}

function imagePathFor(directory: string, mediaType: string, bytes: Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex")
  const extension = extensionFromImageMime(mediaType) ?? DEFAULT_IMAGE_EXTENSION
  return join(directory, `${digest}${extension}`)
}

function writeUnlessPresent(directory: string, filePath: string, bytes: Buffer): void {
  if (existsSync(filePath)) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(filePath, bytes)
}
