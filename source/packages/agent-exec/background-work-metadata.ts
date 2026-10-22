/**
 * The metadata a background task carries in the message that started it, written so it can be read back.
 *
 * A background task is started by a tool call and read back much later, by a process that may not have seen the call.
 * So the little that identifies it — a title for the user to read, the directory it ran in, when it started — is
 * written into the message as strings, because the store it passes through keeps strings, and a value that cannot be
 * written is left out rather than written wrongly. Reading it back tolerates anything: a store that lost a field, or
 * kept a number as text, still yields what is there.
 */

/** The fields a background task keeps so it can be named, found and timed after the call that started it is gone. */
export interface BackgroundWorkMetadata {
  title?: string;
  cwd?: string;
  startTimeMs?: number;
}

/** A field is worth storing only when it says something: a blank or non-string value says nothing. */
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A start time is worth storing only as a positive, finite millisecond count. */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A stored start time is text that parses to a positive, finite number; it comes back whole. */
function startTimeFromText(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function encodeBackgroundWorkMetadata(metadata: BackgroundWorkMetadata): Record<string, string> | undefined {
  const encoded: Record<string, string> = {};
  if (hasText(metadata.title)) encoded.title = metadata.title;
  if (hasText(metadata.cwd)) encoded.cwd = metadata.cwd;
  const startTimeMs = metadata.startTimeMs;
  if (isPositiveFiniteNumber(startTimeMs)) encoded.startTimeMs = String(Math.floor(startTimeMs));
  if (Object.keys(encoded).length === 0) return undefined;
  return encoded;
}

export function decodeBackgroundWorkMetadata(metadata: Record<string, unknown> | null | undefined): BackgroundWorkMetadata {
  const decoded: BackgroundWorkMetadata = {};
  const title = metadata?.title;
  if (hasText(title)) decoded.title = title;
  const cwd = metadata?.cwd;
  if (hasText(cwd)) decoded.cwd = cwd;
  const startTimeMs = startTimeFromText(metadata?.startTimeMs);
  if (startTimeMs !== undefined) decoded.startTimeMs = startTimeMs;
  return decoded;
}
