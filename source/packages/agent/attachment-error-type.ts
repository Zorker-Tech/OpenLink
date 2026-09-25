/**
 * The type of a failure, for reporting, when the failure may not be an Error at all.
 *
 * A failure while reading an attachment or spilling a file can arrive as anything — an Error, a string, a
 * thrown object — and what the report needs is a category, not the message: the message may carry the
 * user's own content, and the category is what is compared across runs. An Error with no name is still an
 * Error, and anything else is reported as its JavaScript type.
 */

export function getSafeErrorType(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error
}
