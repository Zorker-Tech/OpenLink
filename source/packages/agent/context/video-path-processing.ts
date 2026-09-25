/**
 * An attached video that is only a path.
 *
 * The cheapest way to attach a video is to name the file, and the platform then works with the path
 * rather than the bytes: nothing is read, nothing is uploaded, and the tools that need it open it where
 * it is. What the caller gets back is the attachment with its path resolved to the trusted one, the mime
 * type it claims, and the file name to show — or nothing at all when the attachment was not path-only,
 * which is the signal to use the byte-carrying path instead.
 *
 * A path that is not trusted is reported as having no local file rather than as a failure: the attachment
 * still exists, it simply cannot be opened from here, and the caller decides what to do with that. A
 * mime type that is not a video is an error, because the tools that receive it would fail confusingly.
 */

import path from "node:path"

import type { Context } from "../../context/context.ts"
import {
  SelectedVideo,
  type SelectedVideo as SelectedVideoValue,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"
import {
  resolveTrustedPathOnlyAttachmentPath,
  type AttachmentPathRequestContext,
} from "./path-trust.ts"

export interface ProcessSelectedVideoPathOnlyArgs {
  readonly ctx: Context
  readonly selectedVideo: SelectedVideoValue
  readonly requestContext: AttachmentPathRequestContext | undefined
}

export interface ProcessedSelectedVideoPathOnly {
  readonly processedSelectedVideo: SelectedVideoValue | undefined
  readonly videoData: undefined
  readonly mimeType: string
  readonly fps: number | undefined
  readonly filename: string
  readonly localFilePath: string | undefined
}

export async function processSelectedVideoPathOnly({
  ctx,
  selectedVideo,
  requestContext,
}: ProcessSelectedVideoPathOnlyArgs): Promise<ProcessedSelectedVideoPathOnly | undefined> {
  const readableVideoPath = selectedVideo.path.trim()
  const pathOnlyVideo = !selectedVideo.dataOrBlobId?.case
    ? await resolveTrustedPathOnlyAttachmentPath(ctx, readableVideoPath, requestContext, "video", true)
    : { hasPathOnlyPayload: false, trustedPath: undefined }
  const displayFilename = selectedVideo.filename
  const mimeType = selectedVideo.mimeType
  const fps = selectedVideo.fps
  if (!pathOnlyVideo.hasPathOnlyPayload) return undefined
  if (pathOnlyVideo.trustedPath === undefined) {
    return {
      processedSelectedVideo: undefined,
      videoData: undefined,
      mimeType,
      fps,
      filename: displayFilename,
      localFilePath: undefined,
    }
  }
  const trustedPathOnlyVideoPath = pathOnlyVideo.trustedPath
  if (!mimeType || !mimeType.startsWith("video/")) {
    throw new Error(`Video attachments require a video/* mime type, got ${mimeType}`)
  }
  return {
    processedSelectedVideo: new SelectedVideo({ ...selectedVideo, path: trustedPathOnlyVideoPath }),
    videoData: undefined,
    mimeType,
    fps,
    localFilePath: trustedPathOnlyVideoPath,
    filename: displayFilename || path.basename(trustedPathOnlyVideoPath),
  }
}
