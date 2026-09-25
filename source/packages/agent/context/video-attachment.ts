/**
 * A video the user attached, made usable by the model that will watch it.
 *
 * A video is far too large to put in a message, so there are only three ways it can reach the model, and
 * which one applies is decided here. A model that watches video itself can be handed the bytes, and the
 * bytes are the whole point — so the size cap is checked, because a video past it is refused rather than
 * truncated into something unwatchable. A session that may store attached media gets a signed URL
 * instead: the bytes are uploaded once and the model is given a link, which is why a video already
 * carrying a signed URL is only re-signed rather than re-uploaded. And a subagent that runs on a machine
 * of its own cannot be handed bytes at all, so the video is materialised into the workspace's uploads
 * folder and referred to by path — the same arrangement as an attached document, including the name that
 * cannot collide with an earlier upload.
 *
 * What is refused is as much a part of this as what is accepted: a video for a model that cannot watch
 * one, a frame rate outside what the platform supports, a mime type that is not a video at all, a signed
 * URL in a session whose privacy mode does not allow storing attached media, and an attachment with no
 * data behind it. Each of those is a caller's mistake rather than a model's, so they are thrown rather
 * than reported as a result.
 */

import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import { writeExecutorResource } from "../../agent-exec/write-operation.ts"
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.ts"
import {
  SelectedVideo,
  SelectedVideo_SignedUrl,
  type SelectedVideo as SelectedVideoValue,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"
import type { PrivacyMode } from "../../redaction/privacy-mode.ts"
import {
  hydrateSelectedAttachmentData,
  type AttachmentBlobStore,
} from "./attachment-hydration.ts"
import { getSafeErrorType } from "../attachment-error-type.ts"
import { appendRandomUploadSuffix } from "./attachment-filenames.ts"
import {
  isGeminiModelId,
  isSignedUrlStorageAllowed,
  uploadAttachedMediaToSignedUrl,
} from "../attached-media.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"

interface VideoWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>
}

export interface VideoResourceAccessor {
  get(resource: typeof writeExecutorResource): VideoWriteExecutor
}

export interface AttachedMediaUrlProvider {
  getSignedUrlForAttachedMedia(
    ctx: Context,
    request: {
      readonly conversationId: string
      readonly key?: string
      readonly mimeType: string
      readonly contentLengthBytes?: number
    },
  ): Promise<{
    readonly key: string
    readonly putUrl: string
    readonly getUrl: string
    readonly expiresAtUnixMs: bigint
    readonly refreshAfterUnixMs: bigint
  }>
}

export interface ProcessVideoAttachmentArgs {
  readonly ctx: Context
  readonly blobStore: AttachmentBlobStore<Context>
  readonly selectedVideo: SelectedVideoValue
  readonly index: number
  readonly modelId: string | undefined
  readonly maxVideoBytes: number
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly resourceAccessor: VideoResourceAccessor | undefined
  readonly privacyMode?: PrivacyMode
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider
  readonly conversationId?: string
}

export interface ProcessedVideoAttachment {
  readonly processedSelectedVideo: SelectedVideoValue | undefined
  readonly videoData: Uint8Array | undefined
  readonly mimeType: string
  readonly fps: number | undefined
  readonly filename: string
  readonly localFilePath?: string
  readonly videoUrl?: string
}

const logger = createLogger("agent/context-processing")

/** Where a video is written for a subagent that cannot be handed its bytes. */
const UPLOADS_DIR = "uploads"

/** What the platform supports: below this a video has too few frames, above it too many to send. */
const MIN_VIDEO_FPS = 0.25
const MAX_VIDEO_FPS = 20

export async function processVideoAttachment({
  ctx,
  blobStore,
  selectedVideo,
  index,
  modelId,
  maxVideoBytes,
  requestContext,
  resourceAccessor,
  privacyMode,
  attachedMediaUrlProvider,
  conversationId,
}: ProcessVideoAttachmentArgs): Promise<ProcessedVideoAttachment> {
  const materializeToFilesystem = selectedVideo.materializeToFilesystem === true
  // A video that is not written to disk has to be watched by the model, and not every model can watch.
  if (!materializeToFilesystem && !isGeminiModelId(modelId)) {
    throw new Error("Video attachments are only supported for Gemini models")
  }
  const fps = selectedVideo.fps
  if (fps !== undefined && (!Number.isFinite(fps) || fps < MIN_VIDEO_FPS || fps > MAX_VIDEO_FPS)) {
    throw new Error(`Video fps must be between ${MIN_VIDEO_FPS} and ${MAX_VIDEO_FPS}, got ${fps}`)
  }
  const mimeType = selectedVideo.mimeType
  if (!mimeType || !mimeType.startsWith("video/")) {
    throw new Error(`Video attachments require a video/* mime type, got ${mimeType}`)
  }

  // A signed URL is only available where the session may store attached media at all.
  const useSignedUrl = !materializeToFilesystem &&
    privacyMode !== undefined &&
    isSignedUrlStorageAllowed(privacyMode) &&
    attachedMediaUrlProvider !== undefined
  if (useSignedUrl && attachedMediaUrlProvider !== undefined) {
    return processVideoUsingSignedUrl({
      ctx,
      blobStore,
      selectedVideo,
      maxVideoBytes,
      mimeType,
      fps,
      attachedMediaUrlProvider,
      conversationId,
    })
  }

  const dataCase = selectedVideo.dataOrBlobId?.case
  if (dataCase !== "data" && dataCase !== "blobId" && dataCase !== "blobIdWithData") {
    if (dataCase === "signedUrl") {
      throw new Error("Attached media signed URLs are not available in this privacy mode")
    }
    throw new Error("Video attachment has no data")
  }
  const hydratedVideo = await hydrateSelectedAttachmentData({
    ctx,
    blobStore,
    attachment: selectedVideo,
    dataOrBlobId: selectedVideo.dataOrBlobId,
    maxBytes: maxVideoBytes,
    missingBlobError: "Video not found in blob store",
    sizeErrorLabel: "Video",
    withBlobId: (blobId: Uint8Array) => new SelectedVideo({
      ...selectedVideo,
      dataOrBlobId: {
        case: "blobId",
        value: blobId,
      },
    }),
  })
  const videoData = hydratedVideo.data
  let processedSelectedVideo = hydratedVideo.processedAttachment
  let videoFilePath: string | undefined
  const filename = selectedVideo.filename ||
    (selectedVideo.path.length > 0 ? path.basename(selectedVideo.path) : `video-${Date.now()}-${index}`)

  if (materializeToFilesystem && videoData) {
    const videoRootPath = requestContext?.env?.projectFolder ?? requestContext?.env?.workspacePaths?.[0]
    if (resourceAccessor && videoRootPath !== undefined) {
      try {
        const safeFilename = appendRandomUploadSuffix(filename, `video-${Date.now()}-${index}`)
        const uploadsDir = path.join(videoRootPath, UPLOADS_DIR)
        const filePath = path.join(uploadsDir, safeFilename)
        const writeExecutor = resourceAccessor.get(writeExecutorResource)
        await writeExecutor.execute(ctx, new WriteArgs({
          path: filePath,
          fileBytes: new Uint8Array(videoData),
          returnFileContentAfterWrite: false,
        }))
        videoFilePath = filePath
        processedSelectedVideo = new SelectedVideo({
          ...(processedSelectedVideo ?? selectedVideo),
          path: filePath,
        })
      } catch (error) {
        // A video that could not be written is dropped rather than failing the turn that carried it.
        logger.warn(ctx, "Failed to write video to filesystem", {
          errorType: getSafeErrorType(error),
        })
        processedSelectedVideo = undefined
      }
    }
  }
  // A video asked to be materialised and not written anywhere has nothing to offer the model.
  if (materializeToFilesystem && videoFilePath === undefined) {
    processedSelectedVideo = undefined
  }
  return {
    processedSelectedVideo,
    // Bytes only travel when they are the way the model will see the video.
    videoData: materializeToFilesystem ? undefined : videoData,
    mimeType,
    fps,
    filename,
    ...(videoFilePath === undefined ? {} : { localFilePath: videoFilePath }),
  }
}

async function processVideoUsingSignedUrl({
  ctx,
  blobStore,
  selectedVideo,
  maxVideoBytes,
  mimeType,
  fps,
  attachedMediaUrlProvider,
  conversationId,
}: {
  readonly ctx: Context
  readonly blobStore: AttachmentBlobStore<Context>
  readonly selectedVideo: SelectedVideoValue
  readonly maxVideoBytes: number
  readonly mimeType: string
  readonly fps: number | undefined
  readonly attachedMediaUrlProvider: AttachedMediaUrlProvider
  readonly conversationId: string | undefined
}): Promise<ProcessedVideoAttachment> {
  const dataOrBlobId = selectedVideo.dataOrBlobId
  // A video that already has a signed URL has already been uploaded, so only the URL is renewed.
  if (dataOrBlobId?.case === "signedUrl") {
    const incomingSignedUrl = dataOrBlobId.value
    const renewed = await attachedMediaUrlProvider.getSignedUrlForAttachedMedia(ctx, {
      conversationId: incomingSignedUrl.conversationId,
      key: incomingSignedUrl.key,
      mimeType,
    })
    const signedUrl = new SelectedVideo_SignedUrl({
      url: renewed.getUrl,
      key: renewed.key,
      expiresAtUnixMs: renewed.expiresAtUnixMs,
      refreshAfterUnixMs: renewed.refreshAfterUnixMs,
      conversationId: incomingSignedUrl.conversationId,
    })
    return {
      processedSelectedVideo: new SelectedVideo({
        ...selectedVideo,
        dataOrBlobId: { case: "signedUrl", value: signedUrl },
      }),
      videoData: undefined,
      videoUrl: signedUrl.url,
      mimeType,
      fps,
      filename: selectedVideo.filename,
    }
  }

  let videoData: Uint8Array | undefined
  if (dataOrBlobId?.case === "data") {
    videoData = dataOrBlobId.value
  } else if (dataOrBlobId?.case === "blobId") {
    videoData = await blobStore.getBlob(ctx, dataOrBlobId.value)
    if (!videoData) {
      throw new Error("Video not found in blob store")
    }
  } else if (dataOrBlobId?.case === "blobIdWithData") {
    videoData = dataOrBlobId.value.data
  } else {
    throw new Error("Video attachment has no data")
  }

  if (videoData.length > maxVideoBytes) {
    throw new Error(`Video exceeds maximum size of ${maxVideoBytes} bytes (${Math.round(maxVideoBytes / 1024 / 1024)}MB)`)
  }
  const resolvedConversationId = conversationId ?? ""
  const signedUrls = await attachedMediaUrlProvider.getSignedUrlForAttachedMedia(ctx, {
    conversationId: resolvedConversationId,
    mimeType,
    contentLengthBytes: videoData.length,
  })
  await uploadAttachedMediaToSignedUrl({
    putUrl: signedUrls.putUrl,
    data: new Uint8Array(videoData),
    mimeType,
    signal: ctx.signal,
  })
  const signedUrl = new SelectedVideo_SignedUrl({
    url: signedUrls.getUrl,
    key: signedUrls.key,
    expiresAtUnixMs: signedUrls.expiresAtUnixMs,
    refreshAfterUnixMs: signedUrls.refreshAfterUnixMs,
    conversationId: resolvedConversationId,
  })
  return {
    processedSelectedVideo: new SelectedVideo({
      ...selectedVideo,
      dataOrBlobId: { case: "signedUrl", value: signedUrl },
    }),
    videoData: undefined,
    videoUrl: signedUrl.url,
    mimeType,
    fps,
    filename: selectedVideo.filename,
  }
}
