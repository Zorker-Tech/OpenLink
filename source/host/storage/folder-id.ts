/**
 * Whether a value can be used as a folder id.
 *
 * A folder id names a directory inside the platform's own storage, so it must be one path component: no
 * separators, no traversal, and nothing empty. The check is a type guard rather than a sanitizer, because a
 * caller that passes something else has a bug rather than a value to clean up.
 */

export function isSafeFolderId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("\0") && id !== "." && id !== ".."
}
