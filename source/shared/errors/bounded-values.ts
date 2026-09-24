/**
 * Bounded values.
 *
 * Strings that may leave the process — telemetry tags, ids echoed into logs — are admitted through
 * here first. A value that is too long, carries free text, or is not one of the values we know about
 * is dropped or folded into a fallback instead of being shipped, so nothing unbounded escapes by
 * accident through an error path.
 */

/** Admits `value` when it is one of `values`, otherwise reports it as `fallback`. */
export function brandedEnumOf<const Values extends readonly string[], const Fallback extends string>(
  values: Values,
  fallback: Fallback,
): (value: string | undefined) => Values[number] | Fallback | undefined {
  const admitted = new Set<string>(values)
  return value => {
    if (value === undefined) return undefined
    return admitted.has(value) ? (value as Values[number]) : fallback
  }
}

/** Pins a literal as one of ours without widening it to `string`. */
export function brandLiteralEnum<const Value extends string>(value: Value): Value {
  return value
}

/** Opaque and short: no whitespace, no quoting, nothing that could carry a message. */
const OPAQUE_ID = /^[0-9A-Za-z._:|-]{1,128}$/

/** An id that is safe to report, or `undefined` when the value is not one. */
export function brandedId(value: string | undefined): string | undefined {
  return value !== undefined && OPAQUE_ID.test(value) ? value : undefined
}

/** The errno values the platform reports; anything else collapses to the fallback. */
export const SLATE_ERRNO_TAGS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EBUSY",
  "EMFILE",
  "EIO",
] as const

export const SLATE_ERRNO_FALLBACK = "E_OTHER" as const

export const brandedErrno = brandedEnumOf(SLATE_ERRNO_TAGS, SLATE_ERRNO_FALLBACK)
