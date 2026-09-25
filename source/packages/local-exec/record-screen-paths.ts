/**
 * The name a recorded screen capture is saved under.
 *
 * A caller may name the file themselves; the name is taken relative to the artifacts directory, refused if it tries to
 * leave it, reduced to characters a file name may hold, kept to a length that fits, and given the extension the
 * recording actually has. Every refusal says which of those rules was broken.
 */
import { RequestedFilePathRejectedReason } from "../proto/generated/agent/v1/record_screen_exec_pb.ts";

export function sanitizeToolCallId(toolCallId: string): string {
  return toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function validateAndNormalizeSaveAsFilename(saveAsFilename: string, artifactsDir: string):
  | { readonly success: true; readonly filename: string }
  | { readonly success: false; readonly reason: RequestedFilePathRejectedReason } {
  let filename = saveAsFilename.trim();
  if (filename.startsWith(artifactsDir)) {
    filename = filename.slice(artifactsDir.length);
    if (filename.startsWith("/")) {
      filename = filename.slice(1);
    }
  }
  filename = filename.trim();
  if (filename.length === 0) {
    return { success: false, reason: RequestedFilePathRejectedReason.UNSPECIFIED };
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return { success: false, reason: RequestedFilePathRejectedReason.SLASHES_NOT_ALLOWED };
  }
  filename = filename.replace(/[^a-zA-Z0-9 ._-]/g, "_");
  filename = filename.trim();
  if (filename.length === 0) {
    return { success: false, reason: RequestedFilePathRejectedReason.UNSPECIFIED };
  }
  if (filename.length > 128) {
    filename = filename.slice(0, 128).trim();
  }
  if (!filename.toLowerCase().endsWith(".mp4")) {
    filename = `${filename}.mp4`;
  }
  return { success: true, filename };
}
