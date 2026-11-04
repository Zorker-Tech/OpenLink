/**
 * The name a recorded screen capture is saved under.
 *
 * A caller may name the file themselves; the name is taken relative to the artifacts directory, refused if it tries to
 * leave it, reduced to characters a file name may hold, kept to a length that fits, and given the extension the
 * recording actually has. Every refusal says which of those rules was broken.
 */
export type SaveAsFilenameRejection = "empty" | "path-separators";

export type SaveAsFilenameResult =
  | { readonly success: true; readonly filename: string }
  | { readonly success: false; readonly reason: SaveAsFilenameRejection };

const MAX_RECORDING_FILENAME_LENGTH = 128;

export function sanitizeToolCallId(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function validateAndNormalizeSaveAsFilename(input: string, artifactsDirectory: string): SaveAsFilenameResult {
  const relativeName = removeArtifactsPrefix(input, artifactsDirectory);
  if (relativeName.length === 0) return { success: false, reason: "empty" };
  if (containsPathSeparator(relativeName)) return { success: false, reason: "path-separators" };

  const safeName = replaceUnsupportedCharacters(relativeName);
  if (safeName.length === 0) return { success: false, reason: "empty" };

  return {
    success: true,
    filename: ensureRecordingExtension(limitFilenameLength(safeName)),
  };
}

function removeArtifactsPrefix(input: string, artifactsDirectory: string): string {
  let filename = input.trim();
  if (filename.startsWith(artifactsDirectory)) {
    filename = filename.slice(artifactsDirectory.length);
    if (filename.startsWith("/")) filename = filename.slice(1);
  }
  return filename.trim();
}

function containsPathSeparator(filename: string): boolean {
  return filename.includes("/") || filename.includes("\\");
}

function replaceUnsupportedCharacters(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9 ._-]/g, "_").trim();
}

function limitFilenameLength(filename: string): string {
  return filename.length > MAX_RECORDING_FILENAME_LENGTH
    ? filename.slice(0, MAX_RECORDING_FILENAME_LENGTH).trim()
    : filename;
}

function ensureRecordingExtension(filename: string): string {
  return filename.toLowerCase().endsWith(".mp4") ? filename : `${filename}.mp4`;
}
