import { attachmentExtension } from "./attachment-open-policy.ts"
import { getFilePreviewKind } from "./file-preview-kind.ts"
import type { AttachmentClassification } from "./attachment-summary-contracts.ts"

const structuredTextExtensions = new Set(["json", "jsonc", "json5", "ndjson"])
const packagedExtensions = new Set(["zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "7z", "rar"])

/** A URL contributes its path, while a plain name remains exactly as supplied. */
export function extensionSubject(source: string): string {
  try {
    return decodeURIComponent(new URL(source).pathname)
  } catch (error) {
    if (error instanceof URIError) {
      try { return new URL(source).pathname }
      catch { return source }
    }
    return source
  }
}

/** Classify names through the preview vocabulary, with a few readable/archive suffixes added for summaries. */
export function classifyPathLike(source: string): AttachmentClassification | null {
  const subject = extensionSubject(source)
  const preview = getFilePreviewKind(subject)

  if (preview === "docx") return "document"
  if (preview === "json") return "json"
  if (preview === "text") {
    const extension = attachmentExtension(subject)
    return extension !== null && structuredTextExtensions.has(extension) ? "json" : "text"
  }
  if (preview === "unknown") {
    const extension = attachmentExtension(subject)
    return extension !== null && packagedExtensions.has(extension) ? "archive" : null
  }
  return preview
}
