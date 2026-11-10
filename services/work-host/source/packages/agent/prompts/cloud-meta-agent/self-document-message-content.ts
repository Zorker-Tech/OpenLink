import { refreshSelfDocumentText } from "./self-document-block.ts"

export interface SelfDocumentContentUpdate {
  readonly found: boolean
  readonly changed: boolean
  readonly content: unknown
}

function unchanged(content: unknown): SelfDocumentContentUpdate {
  return { found: false, changed: false, content }
}

export function refreshSelfDocumentContent(
  content: unknown,
  document: string | null | undefined,
): SelfDocumentContentUpdate {
  if (typeof content === "string") {
    const refreshed = refreshSelfDocumentText(content, document)
    if (refreshed === undefined) return unchanged(content)
    return { found: true, changed: refreshed !== content, content: refreshed }
  }

  if (!Array.isArray(content)) return unchanged(content)

  let found = false
  let changed = false
  const parts: unknown[] = []
  for (const value of content) {
    if (found || typeof value !== "object" || value === null) {
      parts.push(value)
      continue
    }
    const part = value as Record<string, unknown>
    if (part.type !== "text" || typeof part.text !== "string") {
      parts.push(value)
      continue
    }
    const refreshed = refreshSelfDocumentText(part.text, document)
    if (refreshed === undefined) {
      parts.push(value)
      continue
    }
    found = true
    if (refreshed === part.text) {
      parts.push(value)
      continue
    }
    changed = true
    parts.push({ ...part, text: refreshed })
  }

  return found
    ? { found: true, changed, content: changed ? parts : content }
    : unchanged(content)
}
