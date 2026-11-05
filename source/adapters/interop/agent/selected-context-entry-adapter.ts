import type {
  AgentMode,
  SimulatedMsgReason,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type { SelectedCodeSelection, SelectedContext, SelectedTerminalSelection } from "../proto/generated/agent/v1/selected_context_pb.ts"
import {
  PromptUploadRef,
  SelectedImage as SelectedImageMessage,
  SelectedImage_Dimension,
  SelectedImage_BlobIdWithData,
  type SelectedImage as InteropSelectedImage,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { SlateImageAttachment } from "../../../packages/agent/context/image-attachment-contracts.ts"
import type { SlateWorkspaceSelectionContext } from "../../../packages/agent/context/workspace-selection-contracts.ts"
import { projectLsDirectoryTree } from "./ls-directory-tree-adapter.ts"

/** Wire-facing input types for the selected-context processing boundary. */
export type SelectedContextEntryInterop = SelectedContext
export type SelectedContextEntryModeInterop = AgentMode
export type SelectedContextSimulatedReasonInterop = SimulatedMsgReason

function lineRangeFromInterop(range: SelectedCodeSelection["range"] | SelectedTerminalSelection["range"]) {
  if (range === undefined) return undefined
  const position = (value: { readonly line?: number; readonly column?: number } | undefined) => value === undefined
    ? undefined
    : {
        ...(value.line === undefined ? {} : { line: value.line }),
        ...(value.column === undefined ? {} : { column: value.column }),
      }
  const start = position(range.start)
  const end = position(range.end)
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  }
}

/** Projects workspace selections into Slate records before prompt assembly. */
export function projectSelectedWorkspaceContext(selected: SelectedContext): SlateWorkspaceSelectionContext {
  return {
    files: selected.files.map(file => ({
      path: file.path,
      content: file.content,
      ...(file.relativePath === undefined ? {} : { relativePath: file.relativePath }),
    })),
    codeSelections: selected.codeSelections.map(selection => ({
      path: selection.path,
      content: selection.content,
      ...(selection.range === undefined ? {} : { range: lineRangeFromInterop(selection.range) }),
    })),
    terminals: selected.terminals.map(terminal => ({
      content: terminal.content,
      ...(terminal.title === undefined ? {} : { title: terminal.title }),
      ...(terminal.path === undefined ? {} : { path: terminal.path }),
    })),
    terminalSelections: selected.terminalSelections.map(selection => ({
      content: selection.content,
      ...(selection.title === undefined ? {} : { title: selection.title }),
      ...(selection.path === undefined ? {} : { path: selection.path }),
      ...(selection.range === undefined ? {} : { range: lineRangeFromInterop(selection.range) }),
    })),
    folders: selected.folders.map(folder => {
      const directoryTree = folder.directoryTree === undefined
        ? undefined
        : projectLsDirectoryTree(folder.directoryTree)
      return {
        path: folder.path,
        ...(folder.relativePath === undefined ? {} : { relativePath: folder.relativePath }),
        ...(directoryTree === undefined ? {} : { directoryTree }),
      }
    }),
  }
}

export function fromInteropSelectedImage(image: InteropSelectedImage): SlateImageAttachment {
  let content: SlateImageAttachment["content"]
  const dataOrBlobId = image.dataOrBlobId
  switch (dataOrBlobId?.case) {
    case "data":
      content = { kind: "inline-bytes", bytes: new Uint8Array(dataOrBlobId.value) }
      break
    case "blobId":
      content = { kind: "stored-blob", blobId: new Uint8Array(dataOrBlobId.value) }
      break
    case "blobIdWithData":
      content = {
        kind: "blob-with-bytes",
        blobId: new Uint8Array(dataOrBlobId.value.blobId),
        bytes: new Uint8Array(dataOrBlobId.value.data),
      }
      break
    case "promptUploadRef":
      content = { kind: "unresolved-upload", uploadId: dataOrBlobId.value.uploadId }
      break
    case undefined:
      content = undefined
      break
  }
  return {
    id: image.uuid,
    sourcePath: image.path,
    mediaType: image.mimeType,
    ...(image.dimension === undefined ? {} : {
      dimensions: { width: image.dimension.width, height: image.dimension.height },
    }),
    ...(content === undefined ? {} : { content }),
  }
}

export function toInteropSelectedImage(image: SlateImageAttachment): InteropSelectedImage {
  let dataOrBlobId: InteropSelectedImage["dataOrBlobId"]
  switch (image.content?.kind) {
    case "inline-bytes":
      dataOrBlobId = { case: "data", value: new Uint8Array(image.content.bytes) }
      break
    case "stored-blob":
      dataOrBlobId = { case: "blobId", value: new Uint8Array(image.content.blobId) }
      break
    case "blob-with-bytes":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: new SelectedImage_BlobIdWithData({
          blobId: new Uint8Array(image.content.blobId),
          data: new Uint8Array(image.content.bytes),
        }),
      }
      break
    case "unresolved-upload":
      dataOrBlobId = { case: "promptUploadRef", value: new PromptUploadRef({ uploadId: image.content.uploadId }) }
      break
    default:
      dataOrBlobId = { case: undefined }
  }
  return new SelectedImageMessage({
    uuid: image.id,
    path: image.sourcePath,
    mimeType: image.mediaType,
    ...(image.dimensions === undefined ? {} : {
      dimension: new SelectedImage_Dimension({ width: image.dimensions.width, height: image.dimensions.height }),
    }),
    dataOrBlobId,
  })
}
