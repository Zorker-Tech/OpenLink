import {
  PromptUploadRef,
  SelectedDocument,
  SelectedDocument_BlobIdWithData,
  type SelectedDocument as InteropSelectedDocument,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import type { Context } from "../../../packages/context/context.ts"
import {
  processDocumentAttachment,
  type ProcessDocumentAttachmentArgs,
  type ProcessedDocumentAttachment,
} from "../../../packages/agent/context/document-attachment.ts"
import type { AttachmentContentStore } from "../../../packages/agent/context/attachment-hydration.ts"
import type { SlateDocumentAttachment } from "../../../packages/agent/context/document-attachment-contracts.ts"
import type { AttachmentPathRequestContext } from "../../../packages/agent/context/path-trust.ts"
import { writeWorkspaceBytesThroughInterop, type InteropWorkspaceFileWriteAccessor } from "./workspace-file-write-adapter.ts"
import { copySelectedContextBytes, readSelectedContextText } from "./selected-context-value-adapter.ts"

export interface ProcessInteropDocumentAttachmentArgs {
  readonly ctx: Context
  readonly blobStore: AttachmentContentStore<Context> | undefined
  readonly selectedDocument: InteropSelectedDocument
  readonly index: number
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly resourceAccessor: InteropWorkspaceFileWriteAccessor | undefined
}

export interface ProcessedInteropDocumentAttachment extends Omit<ProcessedDocumentAttachment, "selectedDocument"> {
  readonly selectedDocument: InteropSelectedDocument | undefined
}

export interface ProcessSlateDocumentAttachmentArgs extends Omit<ProcessInteropDocumentAttachmentArgs, "selectedDocument"> {
  readonly selectedDocument: SlateDocumentAttachment
}

export function fromInteropSelectedDocument(document: InteropSelectedDocument): SlateDocumentAttachment {
  const payload = document.dataOrBlobId
  let content: SlateDocumentAttachment["content"]
  switch (payload.case) {
    case "data":
      content = { kind: "inline-bytes", bytes: copySelectedContextBytes(payload.value, "document data") }
      break
    case "blobId":
      content = { kind: "stored-blob", blobId: copySelectedContextBytes(payload.value, "document blob id") }
      break
    case "blobIdWithData":
      content = {
        kind: "blob-with-bytes",
        blobId: copySelectedContextBytes(payload.value.blobId, "document blob id"),
        bytes: copySelectedContextBytes(payload.value.data, "document data"),
      }
      break
    case "promptUploadRef":
      content = {
        kind: "unresolved-upload-reference",
        uploadId: readSelectedContextText(payload.value.uploadId, "document upload id"),
      }
      break
    default:
      content = undefined
  }
  return {
    uuid: document.uuid,
    filename: readSelectedContextText(document.filename, "document filename"),
    mimeType: document.mimeType,
    path: readSelectedContextText(document.path, "document path"),
    content,
  }
}

export function toInteropSelectedDocument(document: SlateDocumentAttachment): InteropSelectedDocument {
  let dataOrBlobId: InteropSelectedDocument["dataOrBlobId"] | undefined
  switch (document.content?.kind) {
    case "inline-bytes":
      dataOrBlobId = { case: "data", value: new Uint8Array(document.content.bytes) }
      break
    case "stored-blob":
      dataOrBlobId = { case: "blobId", value: new Uint8Array(document.content.blobId) }
      break
    case "blob-with-bytes":
      dataOrBlobId = {
        case: "blobIdWithData",
        value: new SelectedDocument_BlobIdWithData({ blobId: new Uint8Array(document.content.blobId), data: new Uint8Array(document.content.bytes) }),
      }
      break
    case "unresolved-upload-reference":
      dataOrBlobId = { case: "promptUploadRef", value: new PromptUploadRef({ uploadId: document.content.uploadId }) }
      break
    default:
      dataOrBlobId = undefined
  }
  return new SelectedDocument({
    uuid: document.uuid,
    filename: document.filename,
    mimeType: document.mimeType,
    path: document.path,
    ...(dataOrBlobId === undefined ? {} : { dataOrBlobId }),
  })
}

export async function processSlateDocumentAttachment(
  input: ProcessSlateDocumentAttachmentArgs,
): Promise<ProcessedDocumentAttachment> {
  const { selectedDocument, resourceAccessor, ...coreInput } = input
  return await processDocumentAttachment({
    ...coreInput,
    selectedDocument,
    ...(resourceAccessor === undefined ? {} : {
      writeWorkspaceFile: async (context, path, bytes) => {
        await writeWorkspaceBytesThroughInterop(resourceAccessor, context, path, bytes)
      },
    }),
  } satisfies Omit<ProcessDocumentAttachmentArgs, "selectedDocument"> & { selectedDocument: SlateDocumentAttachment })
}

export async function processInteropDocumentAttachment(
  input: ProcessInteropDocumentAttachmentArgs,
): Promise<ProcessedInteropDocumentAttachment> {
  const result = await processSlateDocumentAttachment({
    ...input,
    selectedDocument: fromInteropSelectedDocument(input.selectedDocument),
  })
  return {
    ...result,
    selectedDocument: result.selectedDocument === undefined ? undefined : toInteropSelectedDocument(result.selectedDocument),
  }
}
