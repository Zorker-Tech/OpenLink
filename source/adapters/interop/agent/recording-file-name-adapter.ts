import { RequestedFilePathRejectedReason } from "../proto/generated/agent/v1/record_screen_exec_pb.ts"
import { validateAndNormalizeSaveAsFilename } from "../../../packages/local-exec/record-screen-paths.ts"

/** Translate Slate's filename decision into the rejected-reason values required by the screen-recording protocol. */
export function validateRecordingFilenameForInterop(input: string, artifactsDirectory: string) {
  const result = validateAndNormalizeSaveAsFilename(input, artifactsDirectory)
  if (result.success) return result

  return {
    success: false as const,
    reason: result.reason === "path-separators"
      ? RequestedFilePathRejectedReason.SLASHES_NOT_ALLOWED
      : RequestedFilePathRejectedReason.UNSPECIFIED,
  }
}
