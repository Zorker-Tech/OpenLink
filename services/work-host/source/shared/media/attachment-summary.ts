import type { SlateAttachmentKind } from "./attachments.ts"
import { classifyMimeType } from "./attachment-summary-mime.ts"
import { classifyPathLike, extensionSubject } from "./attachment-summary-path.ts"
import type { AttachmentClassificationSource } from "./attachment-summary-contracts.ts"

export { classifyMimeType, classifyPathLike, extensionSubject }
export type { AttachmentClassificationSource } from "./attachment-summary-contracts.ts"

/** Pick the first useful hint in its established order: MIME, displayed name, then location. */
export function classifyAttachment(source: AttachmentClassificationSource): SlateAttachmentKind {
  if (source.mimeType != null && source.mimeType.length > 0) {
    const fromMime = classifyMimeType(source.mimeType)
    if (fromMime !== null) return fromMime
  }

  for (const candidate of [source.fileName, source.urlOrPath]) {
    if (candidate == null || candidate.length === 0) continue
    const fromName = classifyPathLike(candidate)
    if (fromName !== null) return fromName
  }
  return "file"
}

/** Summarize counts in first-seen order so adjacent messages read consistently with their inputs. */
export function countAttachmentKinds(kinds: readonly SlateAttachmentKind[]): Array<{ kind: SlateAttachmentKind; count: number }> {
  const frequency = new Map<SlateAttachmentKind, number>()
  for (const kind of kinds) frequency.set(kind, (frequency.get(kind) ?? 0) + 1)
  return Array.from(frequency, ([kind, count]) => ({ kind, count }))
}
