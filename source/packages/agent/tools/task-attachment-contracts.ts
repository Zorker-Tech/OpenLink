import type { SlateImageAttachment } from "../context/image-attachment-contracts.ts"
import type { SlateVideoAttachment } from "../context/video-attachment-contracts.ts"

export type SlateTaskPluginCapability = "unspecified" | "command" | "skill" | "subagent" | `unknown-${number}`

export interface SlateTaskPluginCapabilityReference {
  readonly pluginId: string
  readonly capability: SlateTaskPluginCapability
  readonly sourcePath: string
  readonly snapshotToken: string
  readonly resolvedCommit?: string
}

export interface SlateTaskCommandAttachment {
  readonly name: string
  readonly content: string
  readonly sourcePath?: string
  readonly displayName?: string
  readonly capability?: SlateTaskPluginCapabilityReference
}

/** The selected material a subagent needs at launch, before the task protocol encodes it. */
export interface SlateTaskAttachmentSelection {
  readonly images: readonly SlateImageAttachment[]
  readonly videos: readonly SlateVideoAttachment[]
  readonly commands: readonly SlateTaskCommandAttachment[]
}

export function emptySlateTaskAttachmentSelection(): SlateTaskAttachmentSelection {
  return { images: [], videos: [], commands: [] }
}

function copyImage(image: SlateImageAttachment): SlateImageAttachment {
  const content = image.content
  let copiedContent: SlateImageAttachment["content"]
  switch (content?.kind) {
    case "inline-bytes": copiedContent = { kind: "inline-bytes", bytes: new Uint8Array(content.bytes) }; break
    case "stored-blob": copiedContent = { kind: "stored-blob", blobId: new Uint8Array(content.blobId) }; break
    case "blob-with-bytes": copiedContent = { kind: "blob-with-bytes", blobId: new Uint8Array(content.blobId), bytes: new Uint8Array(content.bytes) }; break
    case "unresolved-upload": copiedContent = { kind: "unresolved-upload", uploadId: content.uploadId }; break
    default: copiedContent = undefined
  }
  return {
    ...image,
    ...(image.dimensions === undefined ? {} : { dimensions: { ...image.dimensions } }),
    ...(copiedContent === undefined ? {} : { content: copiedContent }),
  }
}

function copyVideo(video: SlateVideoAttachment): SlateVideoAttachment {
  let content: SlateVideoAttachment["content"]
  switch (video.content.kind) {
    case "bytes": content = { kind: "bytes", bytes: new Uint8Array(video.content.bytes) }; break
    case "blob": content = { kind: "blob", blobId: new Uint8Array(video.content.blobId) }; break
    case "blob-with-bytes": content = { kind: "blob-with-bytes", blobId: new Uint8Array(video.content.blobId), bytes: new Uint8Array(video.content.bytes) }; break
    case "signed-link": content = { ...video.content }; break
    case "empty": content = { kind: "empty" }; break
  }
  return { ...video, content }
}

/** Copies mutable media bytes so task completion cannot mutate the launch record. */
export function cloneSlateTaskAttachmentSelection(
  selection: SlateTaskAttachmentSelection,
): SlateTaskAttachmentSelection {
  return {
    images: selection.images.map(copyImage),
    videos: selection.videos.map(copyVideo),
    commands: selection.commands.map(command => ({
      ...command,
      ...(command.capability === undefined ? {} : { capability: { ...command.capability } }),
    })),
  }
}
