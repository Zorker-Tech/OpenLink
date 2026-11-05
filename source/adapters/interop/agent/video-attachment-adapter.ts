/** Maps stored video messages to Slate attachment policy and back to the runner message. */

import {
  SelectedVideo,
  SelectedVideo_SignedUrl,
  type SelectedVideo as InteropSelectedVideo,
} from "../proto/generated/agent/v1/selected_context_pb.ts";
import { writeWorkspaceBytesThroughInterop, type InteropWorkspaceFileWriteAccessor } from "./workspace-file-write-adapter.ts";
import type { Context } from "../../../packages/context/context.ts";
import {
  processVideoAttachment,
  type AttachedMediaUrlProvider,
  type ProcessedVideoAttachment,
} from "../../../packages/agent/context/video-attachment.ts";
import type { AttachmentContentStore } from "../../../packages/agent/context/attachment-hydration.ts";
import type { SlateVideoAttachment, SlateVideoContent } from "../../../packages/agent/context/video-attachment-contracts.ts";
import type { AttachmentPathRequestContext } from "../../../packages/agent/context/path-trust.ts";
import type { PrivacyMode } from "../../../packages/redaction/privacy-mode.ts";

export type VideoResourceAccessor = InteropWorkspaceFileWriteAccessor;

export interface ProcessInteropVideoAttachmentArgs {
  readonly ctx: Context;
  readonly blobStore: AttachmentContentStore<Context>;
  readonly selectedVideo: InteropSelectedVideo;
  readonly index: number;
  readonly modelId: string | undefined;
  readonly maxVideoBytes: number;
  readonly requestContext: AttachmentPathRequestContext | undefined;
  readonly resourceAccessor: VideoResourceAccessor | undefined;
  readonly privacyMode?: PrivacyMode | undefined;
  readonly attachedMediaUrlProvider?: AttachedMediaUrlProvider | undefined;
  readonly conversationId?: string | undefined;
}

export interface ProcessedInteropVideoAttachment extends Omit<ProcessedVideoAttachment, "processedVideo"> {
  readonly processedSelectedVideo: InteropSelectedVideo | undefined;
}

export interface ProcessSlateVideoAttachmentArgs extends Omit<ProcessInteropVideoAttachmentArgs, "selectedVideo"> {
  readonly selectedVideo: SlateVideoAttachment
}

export function fromInteropSelectedVideo(video: InteropSelectedVideo): SlateVideoAttachment {
  let content: SlateVideoContent = { kind: "empty" };
  switch (video.dataOrBlobId?.case) {
    case "data":
      content = { kind: "bytes", bytes: video.dataOrBlobId.value };
      break;
    case "blobId":
      content = { kind: "blob", blobId: video.dataOrBlobId.value };
      break;
    case "blobIdWithData":
      content = {
        kind: "blob-with-bytes",
        blobId: video.dataOrBlobId.value.blobId,
        bytes: video.dataOrBlobId.value.data,
      };
      break;
    case "signedUrl":
      content = {
        kind: "signed-link",
        url: video.dataOrBlobId.value.url,
        key: video.dataOrBlobId.value.key,
        expiresAtUnixMs: video.dataOrBlobId.value.expiresAtUnixMs,
        refreshAfterUnixMs: video.dataOrBlobId.value.refreshAfterUnixMs,
        conversationId: video.dataOrBlobId.value.conversationId,
      };
  }
  return {
    sourcePath: video.path,
    displayName: video.filename,
    mediaType: video.mimeType,
    ...(video.fps === undefined ? {} : { frameRate: video.fps }),
    writeToWorkspace: video.materializeToFilesystem,
    content,
  };
}

export function toInteropSelectedVideo(video: SlateVideoAttachment): InteropSelectedVideo {
  let dataOrBlobId: InteropSelectedVideo["dataOrBlobId"] | undefined;
  switch (video.content.kind) {
    case "bytes":
      dataOrBlobId = { case: "data", value: video.content.bytes };
      break;
    case "blob":
      dataOrBlobId = { case: "blobId", value: video.content.blobId };
      break;
    case "blob-with-bytes":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: { blobId: video.content.blobId, data: video.content.bytes } as never,
      };
      break;
    case "signed-link":
      dataOrBlobId = {
        case: "signedUrl",
        value: new SelectedVideo_SignedUrl({
          url: video.content.url,
          ...(video.content.key === undefined ? {} : { key: video.content.key }),
          ...(video.content.expiresAtUnixMs === undefined ? {} : { expiresAtUnixMs: video.content.expiresAtUnixMs }),
          ...(video.content.refreshAfterUnixMs === undefined ? {} : { refreshAfterUnixMs: video.content.refreshAfterUnixMs }),
          conversationId: video.content.conversationId,
        }),
      };
      break;
    case "empty":
      dataOrBlobId = undefined;
      break;
  }
  return new SelectedVideo({
    path: video.sourcePath,
    filename: video.displayName,
    mimeType: video.mediaType,
    ...(video.frameRate === undefined ? {} : { fps: video.frameRate }),
    materializeToFilesystem: video.writeToWorkspace,
    ...(dataOrBlobId === undefined ? {} : { dataOrBlobId }),
  });
}

export async function processSlateVideoAttachment(
  input: ProcessSlateVideoAttachmentArgs,
): Promise<ProcessedVideoAttachment> {
  const { resourceAccessor, selectedVideo, ...coreInput } = input;
  return await processVideoAttachment({
    ...coreInput,
    video: selectedVideo,
    ...(resourceAccessor === undefined ? {} : {
      writeWorkspaceFile: async (context, path, bytes) => {
        await writeWorkspaceBytesThroughInterop(resourceAccessor, context, path, bytes);
      },
    }),
  });

}

export async function processInteropVideoAttachment(
  input: ProcessInteropVideoAttachmentArgs,
): Promise<ProcessedInteropVideoAttachment> {
  const result = await processSlateVideoAttachment({
    ...input,
    selectedVideo: fromInteropSelectedVideo(input.selectedVideo),
  });
  return {
    ...result,
    processedSelectedVideo: result.processedVideo === undefined
      ? undefined
      : toInteropSelectedVideo(result.processedVideo),
  };
}
