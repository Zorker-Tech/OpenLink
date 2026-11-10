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
  resolveTrustedPathOnlyAttachmentPath,
  type AttachmentPathRequestContext,
} from "./path-trust.ts"
import type { SlateVideoAttachment } from "./video-attachment-contracts.ts"

export interface ProcessVideoPathOnlyArgs {
  readonly ctx: Context
  readonly path: string
  readonly hasStoredContent: boolean
  readonly mimeType: string
  readonly filename: string
  readonly fps: number | undefined
  readonly requestContext: AttachmentPathRequestContext | undefined
}

export interface ProcessedVideoPathOnly {
  readonly trustedPath: string | undefined
  readonly videoData: undefined
  readonly mimeType: string
  readonly fps: number | undefined
  readonly filename: string
  readonly localFilePath: string | undefined
}

export interface ProcessSlateVideoPathOnlyArgs {
  readonly ctx: Context
  readonly video: SlateVideoAttachment
  readonly requestContext: AttachmentPathRequestContext | undefined
}

export interface ProcessedSlateVideoPathOnly extends Omit<ProcessedVideoPathOnly, "trustedPath"> {
  readonly processedVideo: SlateVideoAttachment | undefined
}

export async function processVideoPathOnlyAttachment({
  ctx,
  path: candidatePath,
  hasStoredContent,
  mimeType,
  filename,
  fps,
  requestContext,
}: ProcessVideoPathOnlyArgs): Promise<ProcessedVideoPathOnly | undefined> {
  const readablePath = candidatePath.trim()
  const attachment = !hasStoredContent
    ? await resolveTrustedPathOnlyAttachmentPath(ctx, readablePath, requestContext, "video", true)
    : { hasPathOnlyPayload: false, trustedPath: undefined }
  if (!attachment.hasPathOnlyPayload) return undefined
  if (attachment.trustedPath === undefined) {
    return {
      trustedPath: undefined,
      videoData: undefined,
      mimeType,
      fps,
      filename,
      localFilePath: undefined,
    }
  }
  if (!mimeType || !mimeType.startsWith("video/")) {
    throw new Error(`Video attachments require a video/* mime type, got ${mimeType}`)
  }
  return {
    trustedPath: attachment.trustedPath,
    videoData: undefined,
    mimeType,
    fps,
    localFilePath: attachment.trustedPath,
    filename: filename || path.basename(attachment.trustedPath),
  }
}

/** Resolves an already-Slate path-only video without crossing the wire-message boundary. */
export async function processSlateVideoPathOnlyAttachment({
  ctx,
  video,
  requestContext,
}: ProcessSlateVideoPathOnlyArgs): Promise<ProcessedSlateVideoPathOnly | undefined> {
  const processed = await processVideoPathOnlyAttachment({
    ctx,
    path: video.sourcePath,
    hasStoredContent: video.content.kind !== "empty",
    mimeType: video.mediaType,
    filename: video.displayName,
    fps: video.frameRate,
    requestContext,
  })
  if (processed === undefined) return undefined
  return {
    processedVideo: processed.trustedPath === undefined ? undefined : { ...video, sourcePath: processed.trustedPath },
    videoData: undefined,
    mimeType: processed.mimeType,
    fps: processed.fps,
    filename: processed.filename,
    localFilePath: processed.localFilePath,
  }
}
