import type { AttachmentClassification } from "./attachment-summary-contracts.ts"

const exactMimeTypes = new Map<string, AttachmentClassification>([
  ["application/pdf", "pdf"],
  ["text/markdown", "markdown"],
  ["text/csv", "table"],
  ["text/tab-separated-values", "table"],
  ["application/vnd.ms-excel", "table"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "table"],
  ["application/msword", "document"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
  ["application/zip", "archive"],
  ["application/x-zip-compressed", "archive"],
  ["application/gzip", "archive"],
  ["application/x-tar", "archive"],
  ["application/x-bzip2", "archive"],
  ["application/x-xz", "archive"],
  ["application/zstd", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/x-rar-compressed", "archive"],
  ["application/vnd.rar", "archive"],
])

/** Resolve a kind directly when MIME names it; families are handled only after exact formats. */
export function classifyMimeType(rawMimeType: string): AttachmentClassification | null {
  const mime = (rawMimeType.split(";", 1)[0] ?? "").trim().toLowerCase()
  const direct = exactMimeTypes.get(mime)
  if (direct !== undefined) return direct

  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (mime === "application/json" || mime.endsWith("+json")) return "json"
  return mime.startsWith("text/") ? "text" : null
}
