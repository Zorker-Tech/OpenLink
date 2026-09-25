/**
 * The metadata a background task carries in the message that started it, written so it can be read back.
 *
 * A background task is started by a tool call and read back much later, by a process that may not have seen the call. So the little that identifies it — a title for the user to read, the directory it ran in, when it started — is written into the message as strings, because the store it passes through keeps strings, and a value that cannot be written is left out rather than written wrongly. Reading it back tolerates anything: a store that lost a field, or kept a number as text, still yields what is there.
 */

export interface BackgroundWorkMetadata { title?: string; cwd?: string; startTimeMs?: number }

export function encodeBackgroundWorkMetadata(metadata: BackgroundWorkMetadata): Record<string, string> | undefined {
  const encoded: Record<string, string> = {};
  if (typeof metadata.title === "string" && metadata.title.trim().length > 0) encoded.title = metadata.title;
  if (typeof metadata.cwd === "string" && metadata.cwd.trim().length > 0) encoded.cwd = metadata.cwd;
  if (typeof metadata.startTimeMs === "number" && Number.isFinite(metadata.startTimeMs) && metadata.startTimeMs > 0) {
    encoded.startTimeMs = String(Math.floor(metadata.startTimeMs));
  }
  return Object.keys(encoded).length > 0 ? encoded : undefined;
}

export function decodeBackgroundWorkMetadata(metadata: Record<string, unknown> | null | undefined): BackgroundWorkMetadata {
  const decoded: BackgroundWorkMetadata = {};
  if (typeof metadata?.title === "string" && metadata.title.trim().length > 0) decoded.title = metadata.title;
  if (typeof metadata?.cwd === "string" && metadata.cwd.trim().length > 0) decoded.cwd = metadata.cwd;
  if (typeof metadata?.startTimeMs === "string" && metadata.startTimeMs.length > 0) {
    const parsed = Number(metadata.startTimeMs);
    if (Number.isFinite(parsed) && parsed > 0) decoded.startTimeMs = Math.floor(parsed);
  }
  return decoded;
}
