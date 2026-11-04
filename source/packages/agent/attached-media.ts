/**
 * Attached media: how large it may be, where it may go, and how it gets there.
 *
 * A video is too large to inline, so it is either inlined up to a limit, uploaded and referenced by a
 * signed URL, or handed to the subagent that watches videos — and which of those applies depends on the
 * size, the model and the privacy mode. The privacy check is the one worth stating plainly: a signed URL
 * puts the file somewhere the platform does not control, so it is only used when the session's privacy
 * mode already permits the data to leave.
 */

import { PrivacyMode, type PrivacyMode as PrivacyModeValue } from "../redaction/privacy-mode.ts"

const DEFAULT_INLINE_VIDEO_MAX_BYTES = 15 * 1024 * 1024
const DEFAULT_SIGNED_URL_VIDEO_MAX_BYTES = 15 * 1024 * 1024
export const VIDEO_REVIEW_SUBAGENT_MAX_BYTES = 1024 * 1024 * 1024

interface AttachedMediaConfig {
  readonly featureFlags?: {
    readonly videoAttachmentInlineMaxBytes?: number
    readonly videoAttachmentSignedUrlMaxBytes?: number
  }
}

interface UploadAttachedMediaOptions {
  /** The bytes to upload, as the caller read them. */
  readonly data: Uint8Array
  readonly mimeType: string
  readonly putUrl: string | URL
  readonly signal?: AbortSignal
}

export function getInlineVideoMaxBytes(config: AttachedMediaConfig): number {
  return config.featureFlags?.videoAttachmentInlineMaxBytes ?? DEFAULT_INLINE_VIDEO_MAX_BYTES
}

export function getSignedUrlVideoMaxBytes(config: AttachedMediaConfig): number {
  return config.featureFlags?.videoAttachmentSignedUrlMaxBytes ?? DEFAULT_SIGNED_URL_VIDEO_MAX_BYTES
}

/** A signed URL hands the file to storage outside the platform, so the privacy mode has to allow it. */
export function isSignedUrlStorageAllowed(privacyMode: PrivacyModeValue): boolean {
  return privacyMode === PrivacyMode.NO_TRAINING ||
    privacyMode === PrivacyMode.USAGE_DATA_TRAINING_ALLOWED ||
    privacyMode === PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED
}

export async function uploadAttachedMediaToSignedUrl(options: UploadAttachedMediaOptions): Promise<void> {
  const response = await fetch(options.putUrl, {
    method: "PUT",
    body: options.data,
    headers: { "Content-Type": options.mimeType },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    throw new Error(`Failed to upload attached media: ${response.status} ${response.statusText}`)
  }
}
