/**
 * The entity tag a store answers with.
 *
 * The quotes the object store wraps around a tag are not part of it, so they are stripped on the way in, and a tag
 * that is not there at all is the empty one rather than a missing value.
 */
export function stripS3EtagQuotes(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return "";
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}
export function normalizeS3Etag(raw: string | null | undefined): string { return stripS3EtagQuotes(raw).toLowerCase(); }
