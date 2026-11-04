/**
 * Make an attached video usable by the selected model.
 *
 * Slate chooses whether bytes travel inline, through a stored-media link, or through a workspace path.
 * The input and result here use Slate's video record; a separate adapter handles the persisted video message.
 */

import path from "node:path";

import type { Context } from "../../context/context.ts";
import { createLogger } from "../../context/index.ts";
import type { PrivacyMode } from "../../redaction/privacy-mode.ts";
import {
  hydrateAttachmentContent,
  type AttachmentContentReference,
  type AttachmentContentStore,
} from "./attachment-hydration.ts";
import { getSafeErrorType } from "../attachment-error-type.ts";
import { appendRandomUploadSuffix } from "./attachment-filenames.ts";
import {
  isSignedUrlStorageAllowed,
  uploadAttachedMediaToSignedUrl,
} from "../attached-media.ts";
import { isVideoAttachmentModelId } from "../../../adapters/interop/inference/video-model-adapter.ts";
import type { AttachmentPathRequestContext } from "./path-trust.ts";
import type { SlateVideoAttachment, SlateVideoContent } from "./video-attachment-contracts.ts";

export interface AttachedMediaUrlProvider {
  getSignedUrlForAttachedMedia(
    ctx: Context,
    request: {
      readonly conversationId: string;
      readonly key?: string;
      readonly mimeType: string;
      readonly contentLengthBytes?: number;
    },
  ): Promise<{
    readonly key: string;
    readonly putUrl: string;
    readonly getUrl: string;
    readonly expiresAtUnixMs: bigint;
    readonly refreshAfterUnixMs: bigint;
  }>;
}

export interface ProcessVideoAttachmentArgs {
  readonly ctx: Context;
  readonly blobStore: AttachmentContentStore<Context>;
  readonly video: SlateVideoAttachment;
  readonly index: number;
  readonly modelId: string | undefined;
  readonly maxVideoBytes: number;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly writeWorkspaceFile?: ((context: Context, path: string, bytes: Uint8Array) => Promise<void>) | undefined;
  readonly privacyMode?: PrivacyMode | undefined;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly conversationId?: string | undefined;
}

export interface ProcessedVideoAttachment {
  readonly processedVideo: SlateVideoAttachment | undefined;
  readonly videoData: Uint8Array | undefined;
  readonly mimeType: string;
  readonly fps: number | undefined;
  readonly filename: string;
  readonly localFilePath?: string | undefined;
  readonly videoUrl?: string | undefined;
}

const logger = createLogger("agent/context-processing");
const UPLOADS_DIR = "uploads";
const MIN_VIDEO_FPS = 0.25;
const MAX_VIDEO_FPS = 20;

function contentReferenceFor(content: SlateVideoContent): AttachmentContentReference | undefined {
  switch (content.kind) {
    case "bytes": return { kind: "inline-bytes", bytes: content.bytes };
    case "blob": return { kind: "stored-blob", blobId: content.blobId };
    case "blob-with-bytes": return { kind: "blob-with-bytes", blobId: content.blobId, bytes: content.bytes };
    default: return undefined;
  }
}

function contentFromBlobId(video: SlateVideoAttachment, blobId: Uint8Array): SlateVideoAttachment {
  return { ...video, content: { kind: "blob", blobId } };
}

export async function processVideoAttachment({
  ctx,
  blobStore,
  video,
  index,
  modelId,
  maxVideoBytes,
  requestContext,
  writeWorkspaceFile,
  privacyMode,
  attachedMediaUrlProvider,
  conversationId,
}: ProcessVideoAttachmentArgs): Promise<ProcessedVideoAttachment> {
  const materializeToFilesystem = video.writeToWorkspace;
  if (!materializeToFilesystem && !isVideoAttachmentModelId(modelId)) {
    throw new Error("Video attachments require a video-capable model.");
  }
  const fps = video.frameRate;
  if (fps !== undefined && (!Number.isFinite(fps) || fps < MIN_VIDEO_FPS || fps > MAX_VIDEO_FPS)) {
    throw new Error("Video fps must be between " + MIN_VIDEO_FPS + " and " + MAX_VIDEO_FPS + ", got " + fps);
  }
  const mimeType = video.mediaType;
  if (!mimeType || !mimeType.startsWith("video/")) {
    throw new Error("Video attachments require a video/* mime type, got " + mimeType);
  }

  const mayUseSignedUrl = !materializeToFilesystem &&
    privacyMode !== undefined &&
    isSignedUrlStorageAllowed(privacyMode) &&
    attachedMediaUrlProvider !== undefined;
  if (mayUseSignedUrl && attachedMediaUrlProvider !== undefined) {
    return await processVideoUsingSignedUrl({
      ctx,
      blobStore,
      video,
      maxVideoBytes,
      mimeType,
      fps,
      attachedMediaUrlProvider,
      conversationId,
    });
  }

  if (video.content.kind === "signed-link") {
    throw new Error("Attached media signed URLs are not available in this privacy mode");
  }
  const contentReference = contentReferenceFor(video.content);
  if (contentReference === undefined) throw new Error("Video attachment has no data");

  const hydrated = await hydrateAttachmentContent({
    ctx,
    blobStore,
    attachment: video,
    contentReference,
    maxBytes: maxVideoBytes,
    missingBlobError: "Video not found in blob store",
    sizeErrorLabel: "Video",
    withBlobId: blobId => contentFromBlobId(video, blobId),
  });
  const videoData = hydrated.data;
  let processedVideo = hydrated.attachment;
  let videoFilePath: string | undefined;
  const filename = video.displayName ||
    (video.sourcePath.length > 0 ? path.basename(video.sourcePath) : "video-" + Date.now() + "-" + index);

  if (materializeToFilesystem && videoData !== undefined) {
    const videoRootPath = requestContext?.env?.projectFolder ?? requestContext?.env?.workspacePaths?.[0];
    if (writeWorkspaceFile !== undefined && videoRootPath !== undefined) {
      try {
        const safeFilename = appendRandomUploadSuffix(filename, "video-" + Date.now() + "-" + index);
        const filePath = path.join(videoRootPath, UPLOADS_DIR, safeFilename);
        await writeWorkspaceFile(ctx, filePath, videoData);
        videoFilePath = filePath;
        processedVideo = { ...(processedVideo ?? video), sourcePath: filePath };
      } catch (error) {
        logger.warn(ctx, "Failed to write video to filesystem", { errorType: getSafeErrorType(error) });
        processedVideo = undefined;
      }
    }
  }
  if (materializeToFilesystem && videoFilePath === undefined) processedVideo = undefined;

  return {
    processedVideo,
    videoData: materializeToFilesystem ? undefined : videoData,
    mimeType,
    fps,
    filename,
    ...(videoFilePath === undefined ? {} : { localFilePath: videoFilePath }),
  };
}

async function processVideoUsingSignedUrl({
  ctx,
  blobStore,
  video,
  maxVideoBytes,
  mimeType,
  fps,
  attachedMediaUrlProvider,
  conversationId,
}: {
  readonly ctx: Context;
  readonly blobStore: AttachmentContentStore<Context>;
  readonly video: SlateVideoAttachment;
  readonly maxVideoBytes: number;
  readonly mimeType: string;
  readonly fps: number | undefined;
  readonly attachedMediaUrlProvider: AttachedMediaUrlProvider;
  readonly conversationId: string | undefined;
}): Promise<ProcessedVideoAttachment> {
  const content = video.content;
  if (content.kind === "signed-link") {
    const renewed = await attachedMediaUrlProvider.getSignedUrlForAttachedMedia(ctx, {
      conversationId: content.conversationId,
      ...(content.key === undefined ? {} : { key: content.key }),
      mimeType,
    });
    const renewedContent: SlateVideoContent = {
      kind: "signed-link",
      url: renewed.getUrl,
      key: renewed.key,
      expiresAtUnixMs: renewed.expiresAtUnixMs,
      refreshAfterUnixMs: renewed.refreshAfterUnixMs,
      conversationId: content.conversationId,
    };
    return {
      processedVideo: { ...video, content: renewedContent },
      videoData: undefined,
      videoUrl: renewed.getUrl,
      mimeType,
      fps,
      filename: video.displayName,
    };
  }

  let videoData: Uint8Array | undefined;
  if (content.kind === "bytes") {
    videoData = content.bytes;
  } else if (content.kind === "blob") {
    videoData = await blobStore.getBlob(ctx, content.blobId);
    if (!videoData) throw new Error("Video not found in blob store");
  } else if (content.kind === "blob-with-bytes") {
    videoData = content.bytes;
  } else {
    throw new Error("Video attachment has no data");
  }

  if (videoData.length > maxVideoBytes) {
    throw new Error("Video exceeds maximum size of " + maxVideoBytes + " bytes (" +
      Math.round(maxVideoBytes / 1024 / 1024) + "MB)");
  }
  const uploadConversationId = conversationId ?? "";
  const signedUrls = await attachedMediaUrlProvider.getSignedUrlForAttachedMedia(ctx, {
    conversationId: uploadConversationId,
    mimeType,
    contentLengthBytes: videoData.length,
  });
  await uploadAttachedMediaToSignedUrl({
    putUrl: signedUrls.putUrl,
    data: new Uint8Array(videoData),
    mimeType,
    signal: ctx.signal,
  });
  const signedContent: SlateVideoContent = {
    kind: "signed-link",
    url: signedUrls.getUrl,
    key: signedUrls.key,
    expiresAtUnixMs: signedUrls.expiresAtUnixMs,
    refreshAfterUnixMs: signedUrls.refreshAfterUnixMs,
    conversationId: uploadConversationId,
  };
  return {
    processedVideo: { ...video, content: signedContent },
    videoData: undefined,
    videoUrl: signedUrls.getUrl,
    mimeType,
    fps,
    filename: video.displayName,
  };
}
