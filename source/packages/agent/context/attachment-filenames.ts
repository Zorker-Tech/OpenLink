/**
 * Naming an uploaded file so that two uploads cannot collide.
 *
 * A user can attach two files with the same name, and both are written to the same directory — so the
 * name is made safe for a path and given a short random suffix. The suffix goes before the extension
 * rather than after it, because a file the agent is asked to read should still look like the kind of file
 * it is.
 */

import { randomUUID } from "node:crypto"
import path from "node:path"

import { sanitizeFilename } from "../../utils/managed-paths.ts"

export function appendRandomUploadSuffix(filename: string, fallbackFilename: string): string {
  const sanitizedFilename = sanitizeFilename(filename) || fallbackFilename
  const suffix = randomUUID().replace(/[^a-zA-Z0-9]/g, "").slice(0, 4) || "file"
  const extension = path.extname(sanitizedFilename)
  if (extension.length === 0) return `${sanitizedFilename}_${suffix}`
  const stem = sanitizedFilename.slice(0, -extension.length)
  // A name that is only an extension has no stem to put the suffix on.
  if (stem.length === 0) return `${sanitizedFilename}_${suffix}`
  return `${stem}_${suffix}${extension}`
}
