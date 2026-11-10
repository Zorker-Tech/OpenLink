/**
 * The entity tag a store answers with.
 *
 * The quotes the object store wraps around a tag are not part of it, so they are stripped on the way in, and a tag that
 * is not there at all is the empty one rather than a missing value.
 */

/** The character an object store wraps an entity tag in. */
const QUOTE = '"';

/** An entity tag without the quotes around it; a missing or empty tag is the empty string. */
export function stripS3EtagQuotes(value: string | null | undefined): string {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) return "";
  const quoted = candidate.startsWith(QUOTE) && candidate.endsWith(QUOTE);
  return quoted ? candidate.slice(1, -1) : candidate;
}

/** The tag in the form a conditional request compares: unquoted and lower case. */
export function normalizeS3Etag(value: string | null | undefined): string {
  return stripS3EtagQuotes(value).toLowerCase();
}
