/**
 * Whether a value can be used as a folder id.
 *
 * A folder id names a directory inside the platform's own storage, so it must be one path component: no
 * separators, no traversal, and nothing empty. The check is a type guard rather than a sanitizer, because a
 * caller that passes something else has a bug rather than a value to clean up.
 */

function isNonEmptyFolderName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function containsPathBoundary(id: string): boolean {
  return ["/", "\\", "\0"].some((separator) => id.includes(separator));
}

function isTraversalSegment(id: string): boolean {
  return id === "." || id === "..";
}

export function isSafeFolderId(id: unknown): id is string {
  return isNonEmptyFolderName(id) && !containsPathBoundary(id) && !isTraversalSegment(id);
}
