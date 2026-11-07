import type {
  RequestContextResult,
} from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import { RequestContextArgs } from "../proto/generated/agent/v1/request_context_exec_pb.ts"
import {
  SelectedContext,
  SelectedImage,
  SelectedImage_BlobIdWithData,
  SelectedCursorCommand,
  SelectedPluginCapabilityRef,
  SelectedPluginCapabilityType,
  SelectedVideo,
  SelectedVideo_BlobIdWithData,
  SelectedVideo_SignedUrl,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type {
  SlateTaskAttachmentSelection,
  SlateTaskCommandAttachment,
  SlateTaskPluginCapability,
} from "../../../packages/agent/tools/task-attachment-contracts.ts"
import { fromInteropSelectedImage, toInteropSelectedImage } from "./selected-context-entry-adapter.ts"
import { fromInteropSelectedVideo, toInteropSelectedVideo } from "./video-attachment-adapter.ts"
export type TaskAttachmentRequestContextResultInterop = RequestContextResult
export type TaskAttachmentRequestContextArgsInterop = InstanceType<typeof RequestContextArgs>
export type TaskSelectedContextInterop = SelectedContext
export type TaskSelectedImageInterop = InstanceType<typeof SelectedImage>
export type TaskSelectedVideoInterop = InstanceType<typeof SelectedVideo>
export type TaskSelectedCursorCommandInterop = SelectedCursorCommand

function capabilityKindFromInterop(value: SelectedPluginCapabilityType): SlateTaskPluginCapability {
  if (value === SelectedPluginCapabilityType.COMMAND) return "command"
  if (value === SelectedPluginCapabilityType.SKILL) return "skill"
  if (value === SelectedPluginCapabilityType.SUBAGENT) return "subagent"
  if (value === SelectedPluginCapabilityType.UNSPECIFIED) return "unspecified"
  return `unknown-${value}`
}

function capabilityKindToInterop(value: SlateTaskPluginCapability): SelectedPluginCapabilityType {
  if (value === "command") return SelectedPluginCapabilityType.COMMAND
  if (value === "skill") return SelectedPluginCapabilityType.SKILL
  if (value === "subagent") return SelectedPluginCapabilityType.SUBAGENT
  if (value === "unspecified") return SelectedPluginCapabilityType.UNSPECIFIED
  const unknown = /^unknown-(-?\d+)$/.exec(value)
  return unknown === null ? SelectedPluginCapabilityType.UNSPECIFIED : Number(unknown[1]) as SelectedPluginCapabilityType
}

function fromInteropTaskCommand(command: TaskSelectedCursorCommandInterop): SlateTaskCommandAttachment {
  const capability = command.pluginCapability
  return {
    name: command.name,
    content: command.content,
    ...(command.fullPath === undefined ? {} : { sourcePath: command.fullPath }),
    ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
    ...(capability === undefined ? {} : {
      capability: {
        pluginId: capability.pluginId,
        capability: capabilityKindFromInterop(capability.capabilityType),
        sourcePath: capability.sourcePath,
        snapshotToken: capability.snapshotToken,
        ...(capability.resolvedCommitSha === undefined ? {} : { resolvedCommit: capability.resolvedCommitSha }),
      },
    }),
  }
}

function toInteropTaskCommand(command: SlateTaskCommandAttachment): TaskSelectedCursorCommandInterop {
  const capability = command.capability
  return new SelectedCursorCommand({
    name: command.name,
    content: command.content,
    ...(command.sourcePath === undefined ? {} : { fullPath: command.sourcePath }),
    ...(command.displayName === undefined ? {} : { displayName: command.displayName }),
    ...(capability === undefined ? {} : {
      pluginCapability: new SelectedPluginCapabilityRef({
        pluginId: capability.pluginId,
        capabilityType: capabilityKindToInterop(capability.capability),
        sourcePath: capability.sourcePath,
        snapshotToken: capability.snapshotToken,
        ...(capability.resolvedCommit === undefined ? {} : { resolvedCommitSha: capability.resolvedCommit }),
      }),
    }),
  })
}

export function fromInteropTaskSelectedContext(context: SelectedContext | undefined): SlateTaskAttachmentSelection | undefined {
  if (context === undefined) return undefined
  return {
    images: context.selectedImages.map(fromInteropSelectedImage),
    videos: context.selectedVideos.map(fromInteropSelectedVideo),
    commands: context.cursorCommands.map(fromInteropTaskCommand),
  }
}

export function toInteropTaskSelectedContext(context: SlateTaskAttachmentSelection | undefined): SelectedContext | undefined {
  if (context === undefined) return undefined
  return new SelectedContext({
    selectedImages: context.images.map(toInteropSelectedImage),
    selectedVideos: context.videos.map(toInteropSelectedVideo),
    cursorCommands: context.commands.map(toInteropTaskCommand),
  })
}

export function createTaskAttachmentRequestContextArgsInterop(): InstanceType<typeof RequestContextArgs> {
  return new RequestContextArgs()
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
