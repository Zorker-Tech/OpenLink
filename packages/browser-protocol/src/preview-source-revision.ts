const PREVIEW_SOURCE_REVISION_PATTERN = /^git-sha256:[a-f0-9]{64}$/

/** Validate the opaque, content-derived source revision attached to Preview context. */
export function isPreviewSourceRevision(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_SOURCE_REVISION_PATTERN.test(value)
}
