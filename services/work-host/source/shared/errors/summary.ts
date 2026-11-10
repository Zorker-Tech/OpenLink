/**
 * One-line summaries of a thrown value.
 *
 * What was thrown is `unknown` by contract: an `Error`, a string, a rejected value of any shape. Log
 * lines and span attributes need the same small normalization of it, and neither may throw while
 * describing a failure.
 */

/** The message of whatever was thrown, or its string form when it is not an Error. */
export function errorMessage(failure: unknown): string {
  if (typeof failure === "string") return failure
  if (failure instanceof Error) return failure.message
  return String(failure)
}

function errorCodeOf(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: unknown }).code
  return typeof code === "string" && code.length > 0 ? code : undefined
}

/**
 * A short tag for logs: `TypeError (ENOENT)`, `TypeError`, or — when the thrown value is not an
 * Error at all — its type, which is all a log line can honestly say about it.
 */
export function errorLogTag(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = errorCodeOf(error)
  return code === undefined ? error.name : `${error.name} (${code})`
}
