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

/** The text written after the marker, when the error carries one at all. */
function textAfterMarker(error: string): string | undefined {
  const markerIndex = error.indexOf(METADATA_MARKER)
  return markerIndex < 0 ? undefined : error.slice(markerIndex + METADATA_MARKER.length)
}

/** The record a metadata payload parses to, when it parses to an object at all. */
function parsedRecord(payload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload)
    return parsed === null || typeof parsed !== "object" ? undefined : (parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/** The string a field holds, or nothing when it is absent or of another type. */
function textField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** The boolean a field holds, or nothing when it is absent or of another type. */
function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function parseSmartModeClassifierFailureMetadata(
  error: string | undefined,
): SmartModeClassifierFailureMetadata | undefined {
  if (error === undefined) return undefined
  const payload = textAfterMarker(error)
  if (payload === undefined) return undefined
  const record = parsedRecord(payload)
  if (record === undefined) return undefined
  return { failureReason: textField(record.failureReason), retryable: booleanField(record.retryable) }
}
