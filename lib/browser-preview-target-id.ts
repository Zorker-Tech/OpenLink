const PREVIEW_TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isPreviewTargetId(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_TARGET_ID_PATTERN.test(value)
}
