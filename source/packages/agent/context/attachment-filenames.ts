import { randomUUID } from "node:crypto"
import path from "node:path"

import { sanitizeFilename } from "../../utils/managed-paths.ts"

function safeAttachmentName(original: string, fallback: string): string {
  return sanitizeFilename(original) || fallback
}

function uploadNonce(): string {
  const compactId = randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, 4)
  return compactId || "file"
}

function suffixWholeName(filename: string, suffix: string): string {
  return `${filename}_${suffix}`
}

function placeSuffix(filename: string, suffix: string): string {
  const extension = path.extname(filename)
  if (extension.length === 0) return suffixWholeName(filename, suffix)

  const stem = filename.slice(0, -extension.length)
  if (stem.length === 0) return suffixWholeName(filename, suffix)
  return `${stem}_${suffix}${extension}`
}

export function appendRandomUploadSuffix(filename: string, fallbackFilename: string): string {
  const safeName = safeAttachmentName(filename, fallbackFilename)
  return placeSuffix(safeName, uploadNonce())
}
