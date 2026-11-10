import {
  SelectedVideo,
  type SelectedVideo as SelectedVideoValue,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import {
  processVideoPathOnlyAttachment,
  type ProcessVideoPathOnlyArgs,
} from "../../../packages/agent/context/video-path-processing.ts"

export interface ProcessSelectedVideoPathOnlyArgs {
  readonly ctx: Context
  readonly selectedVideo: SelectedVideoValue
  readonly requestContext: ProcessVideoPathOnlyArgs["requestContext"]
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
  const processed = await processVideoPathOnlyAttachment({
    ctx,
    path: selectedVideo.path,
    hasStoredContent: selectedVideo.dataOrBlobId?.case !== undefined,
    mimeType: selectedVideo.mimeType,
    filename: selectedVideo.filename,
    fps: selectedVideo.fps,
    requestContext,
  })
  if (processed === undefined) return undefined

  return {
    processedSelectedVideo: processed.trustedPath === undefined
      ? undefined
      : new SelectedVideo({ ...selectedVideo, path: processed.trustedPath }),
    videoData: undefined,
    mimeType: processed.mimeType,
    fps: processed.fps,
    filename: processed.filename,
    localFilePath: processed.localFilePath,
  }
}
