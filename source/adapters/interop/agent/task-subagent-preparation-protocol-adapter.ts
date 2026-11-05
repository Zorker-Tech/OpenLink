import type {
  RequestContextResult,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import { RequestContextArgs } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import { ReadArgs } from "../proto/generated/agent/v1/read_exec_pb.ts"
import type { ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts"
import {
  SelectedContext,
  SelectedImage,
  SelectedImage_BlobIdWithData,
  SelectedVideo,
  SelectedVideo_BlobIdWithData,
  SelectedVideo_SignedUrl,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type {
  SelectedCursorCommand,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
export type TaskAttachmentRequestContextResultInterop = RequestContextResult
export type TaskAttachmentReadResultInterop = ReadResult
export type TaskAttachmentRequestContextArgsInterop = InstanceType<typeof RequestContextArgs>
export type TaskAttachmentReadArgsInterop = InstanceType<typeof ReadArgs>
export type TaskSelectedContextInterop = SelectedContext
export type TaskSelectedImageInterop = InstanceType<typeof SelectedImage>
export type TaskSelectedVideoInterop = InstanceType<typeof SelectedVideo>
export type TaskSelectedCursorCommandInterop = SelectedCursorCommand

export function createTaskAttachmentRequestContextArgsInterop(): InstanceType<typeof RequestContextArgs> {
  return new RequestContextArgs()
}

export function createTaskAttachmentReadArgsInterop(input: {
  readonly path: string
  readonly toolCallId: string
}): InstanceType<typeof ReadArgs> {
  return new ReadArgs(input)
}

export function createTaskSelectedContextInterop(input: {
  readonly selectedImages?: readonly InstanceType<typeof SelectedImage>[]
  readonly selectedVideos?: readonly InstanceType<typeof SelectedVideo>[]
  readonly cursorCommands?: readonly TaskSelectedCursorCommandInterop[]
} = {}): TaskSelectedContextInterop {
  return new SelectedContext({
    ...(input.selectedImages === undefined ? {} : { selectedImages: [...input.selectedImages] }),
    ...(input.selectedVideos === undefined ? {} : { selectedVideos: [...input.selectedVideos] }),
    ...(input.cursorCommands === undefined ? {} : { cursorCommands: [...input.cursorCommands] }),
  })
}

export function appendTaskSelectedCursorCommandsInterop(
  selectedContext: TaskSelectedContextInterop | undefined,
  cursorCommands: readonly TaskSelectedCursorCommandInterop[],
): TaskSelectedContextInterop {
  const context = selectedContext ?? new SelectedContext()
  context.cursorCommands = [...cursorCommands]
  return context
}

export function createTaskSelectedImageDataInterop(input: {
  readonly data: Uint8Array
  readonly blobId?: Uint8Array
}): SelectedImage["dataOrBlobId"] {
  return input.blobId !== undefined && input.blobId.length > 0
    ? {
        case: "blobIdWithData",
        value: new SelectedImage_BlobIdWithData({
          blobId: new Uint8Array(input.blobId),
          data: new Uint8Array(input.data),
        }),
      }
    : { case: "data", value: new Uint8Array(input.data) }
}

export function createTaskSelectedVideoDataInterop(input: {
  readonly data: Uint8Array
  readonly blobId?: Uint8Array
}): SelectedVideo["dataOrBlobId"] {
  return input.blobId !== undefined && input.blobId.length > 0
    ? {
        case: "blobIdWithData",
        value: new SelectedVideo_BlobIdWithData({
          blobId: new Uint8Array(input.blobId),
          data: new Uint8Array(input.data),
        }),
      }
    : { case: "data", value: new Uint8Array(input.data) }
}

export function createTaskSelectedImageInterop(input: {
  readonly dataOrBlobId: SelectedImage["dataOrBlobId"]
  readonly uuid: string
  readonly path: string
  readonly mimeType: string
}): InstanceType<typeof SelectedImage> {
  return new SelectedImage(input)
}

export function createTaskSelectedVideoInterop(input: {
  readonly dataOrBlobId?: SelectedVideo["dataOrBlobId"]
  readonly uuid: string
  readonly path: string
  readonly mimeType: string
  readonly filename?: string
  readonly fps: number
}): InstanceType<typeof SelectedVideo> {
  return new SelectedVideo(input)
}

export function createTaskSelectedVideoSignedUrlInterop(input: {
  readonly url: string
  readonly key: string
  readonly expiresAtUnixMs: bigint
  readonly refreshAfterUnixMs: bigint
  readonly conversationId: string
  readonly uuid: string
  readonly path: string
  readonly mimeType: string
  readonly filename?: string
  readonly fps: number
}): InstanceType<typeof SelectedVideo> {
  const { uuid, path, mimeType, filename, fps, ...signedUrl } = input
  return new SelectedVideo({
    dataOrBlobId: {
      case: "signedUrl",
      value: new SelectedVideo_SignedUrl(signedUrl),
    },
    uuid,
    path,
    mimeType,
    ...(filename === undefined ? {} : { filename }),
    fps,
  })
}
