/**
 * The metadata a failed smart-mode classification carries in its error text.
 *
 * A classification failure is shown to the user, and the tool call that caused it has already been
 * recorded — so the reason and whether a retry could help travel inside the error string, after a
 * marker, where they survive being stored and re-read. Parsing is tolerant: an error without the
 * marker, or with a marker but unreadable payload, is simply an error without metadata.
 */

export const SMART_MODE_CLASSIFIER_MANUAL_REVIEW_ERROR_REASON =
  "An error occured while classifying this action. Please review manually."
export const METADATA_MARKER = "\n\nSmartModeClassifierFailureMetadata:"

export interface SmartModeClassifierFailureMetadata {
  failureReason: string | undefined
  retryable: boolean | undefined
}

export function parseSmartModeClassifierFailureMetadata(
  error: string | undefined,
): SmartModeClassifierFailureMetadata | undefined {
  if (error === undefined) return undefined
  const markerIndex = error.indexOf(METADATA_MARKER)
  if (markerIndex < 0) return undefined
  try {
    const parsed: unknown = JSON.parse(error.slice(markerIndex + METADATA_MARKER.length))
    if (parsed === null || typeof parsed !== "object") return undefined
    const record = parsed as Record<string, unknown>
    return {
      failureReason: typeof record.failureReason === "string" ? record.failureReason : undefined,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
    }
  } catch {
    return undefined
  }
}
