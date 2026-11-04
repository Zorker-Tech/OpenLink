/**
 * Bounded values.
 *
 * Strings that may leave the process — telemetry tags, ids echoed into logs — are admitted through
 * here first. A value that is too long, carries free text, or is not one of the values we know about
 * is dropped or folded into a fallback instead of being shipped, so nothing unbounded escapes by
 * accident through an error path.
 */

/**
 * A reader that admits one of `values` and reports anything else as `fallback`.
 *
 * The admitted values are a set, built once: a tag arriving ten thousand times is looked up, not scanned.
 */
export function brandedEnumOf<const Values extends readonly string[], const Fallback extends string>(
  values: Values,
  fallback: Fallback,
): (value: string | undefined) => Values[number] | Fallback | undefined {
  const admitted: ReadonlySet<string> = new Set(values)
  return (value) => {
    if (value === undefined) return undefined
    return admitted.has(value) ? (value as Values[number]) : fallback
  }
}

/** Pins a literal as one of ours without widening it to `string`. */
export function brandLiteralEnum<const Value extends string>(value: Value): Value {
  return value
}

const MAXIMUM_OPAQUE_ID_LENGTH = 128
const OPAQUE_ID_CHARACTER = /^[0-9A-Za-z._:|-]$/

export function brandedId(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > MAXIMUM_OPAQUE_ID_LENGTH) return undefined
  for (const character of value) {
    if (!OPAQUE_ID_CHARACTER.test(character)) return undefined
  }
  return value
}

const admittedErrnoNames =
  "ECONNREFUSED ECONNRESET ECONNABORTED ETIMEDOUT EPIPE ENETRESET ENETDOWN ENETUNREACH " +
  "EHOSTUNREACH EHOSTDOWN EAI_AGAIN ENOTFOUND EADDRINUSE EACCES EPERM ENOENT ENOSPC " +
  "EDQUOT EROFS EBUSY EMFILE EIO"

export const SLATE_ERRNO_TAGS: readonly string[] = Object.freeze(admittedErrnoNames.split(" "))

export const SLATE_ERRNO_FALLBACK = "E_OTHER" as const

export const brandedErrno = brandedEnumOf(SLATE_ERRNO_TAGS, SLATE_ERRNO_FALLBACK)
