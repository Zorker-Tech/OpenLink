/**
 * A document the user attached, made readable by the agent.
 *
 * A document arrives as bytes or as a reference to bytes already stored, and the first job is to have the
 * bytes: either they are inlined and get stored, or they are fetched from the blob store, and a reference
 * that no longer resolves is an error rather than an empty document. The second job is to give the agent a
 * path it can open with its own tools, which means writing the document into the workspace's uploads
 * folder — the same folder a path-only attachment is trusted from — under a name that cannot collide with
 * an earlier attachment. A document that arrives as a path with no bytes at all is a different case: it is
 * only accepted when the path is trusted, because otherwise an attachment would be a way to make the agent
 * read any file on the machine.
 *
 * Every step can fail without failing the turn: if the document cannot be written into the workspace, the
 * attachment is dropped and the model is left with the note it was already given, because a turn that
 * cannot see one attached document is better than a turn that does not start. What comes back is the
 * document as it should now be referred to, the bytes for the caller to use, and the path it was written
 * to when that happened.
 */

import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/index.ts"
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.ts"
import {
  SelectedDocument,
  type SelectedDocument as SelectedDocumentValue,
} from "../../proto/generated/agent/v1/selected_context_pb.ts"
import { writeExecutorResource } from "../../agent-exec/write-operation.ts"
import {
  hydrateSelectedAttachmentData,
  type AttachmentBlobStore,
} from "./attachment-hydration.ts"
import { getSafeErrorType } from "../attachment-error-type.ts"
import { appendRandomUploadSuffix } from "./attachment-filenames.ts"
import {
  resolveTrustedPathOnlyAttachmentPath,
  type AttachmentPathRequestContext,
} from "./path-trust.ts"

interface DocumentWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>
}

export interface DocumentResourceAccessor {
  get(resource: typeof writeExecutorResource): DocumentWriteExecutor
}

export interface ProcessDocumentAttachmentArgs {
  readonly ctx: Context
  readonly blobStore: AttachmentBlobStore<Context> | undefined
  readonly selectedDocument: SelectedDocumentValue
  readonly index: number
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly resourceAccessor: DocumentResourceAccessor | undefined
}

export interface ProcessedDocumentAttachment {
  readonly selectedDocument: SelectedDocumentValue | undefined
  readonly docData: Uint8Array | undefined
  readonly mimeType: string
  readonly filename: string
  readonly documentFilePath: string | undefined
}

const logger = createLogger("agent/context-processing")

/** Where an attached document is written so the agent can open it with its own tools. */
const UPLOADS_DIR = "uploads"

export async function processDocumentAttachment({
  ctx,
  blobStore,
  selectedDocument,
  index,
  requestContext,
  resourceAccessor,
}: ProcessDocumentAttachmentArgs): Promise<ProcessedDocumentAttachment> {
  const selectedDocPath = selectedDocument.path.trim()
  const trimmedFilename = selectedDocument.filename.trim()
  // The readable path is the document's own path, or an absolute filename standing in for one.
  const readablePath = selectedDocPath || (path.isAbsolute(trimmedFilename) ? trimmedFilename : "")
  const displayFilename = trimmedFilename && !path.isAbsolute(trimmedFilename)
    ? trimmedFilename
    : path.basename(readablePath)
  const hydratedDocument = await hydrateSelectedAttachmentData({
    ctx,
    blobStore: blobStore!,
    attachment: selectedDocument,
    dataOrBlobId: selectedDocument.dataOrBlobId,
    missingBlobError: "Document not found in blob store",
    sizeErrorLabel: "Document",
    withBlobId: (blobId: Uint8Array) => new SelectedDocument({
      ...selectedDocument,
      dataOrBlobId: {
        case: "blobId",
        value: blobId,
      },
    }),
  })
  const docData = hydratedDocument.data
  let processedSelectedDocument = hydratedDocument.processedAttachment
  // A document with no bytes is only usable as a path, and only when that path is trusted.
  const pathOnlyDocument = !selectedDocument.dataOrBlobId?.case
    ? await resolveTrustedPathOnlyAttachmentPath(
      ctx,
      readablePath,
      requestContext,
      "document",
      false,
    )
    : { hasPathOnlyPayload: false, trustedPath: undefined }
  if (pathOnlyDocument.trustedPath !== undefined) {
    processedSelectedDocument = new SelectedDocument({
      ...selectedDocument,
      path: pathOnlyDocument.trustedPath,
    })
  }
  let documentFilePath: string | undefined
  const filename = displayFilename || `document-${Date.now()}-${index}`
  if (docData) {
    const projectFolder = requestContext?.env?.projectFolder
    const workspaceRootPath = requestContext?.env?.workspacePaths?.[0]
    const documentRootPath = projectFolder ?? workspaceRootPath
    if (resourceAccessor && documentRootPath !== undefined) {
      try {
        const safeFilename = appendRandomUploadSuffix(filename, `document-${Date.now()}-${index}`)
        const uploadsDir = path.join(documentRootPath, UPLOADS_DIR)
        const filePath = path.join(uploadsDir, safeFilename)
        const writeExecutor = resourceAccessor.get(writeExecutorResource)
        await writeExecutor.execute(ctx, new WriteArgs({
          path: filePath,
          fileBytes: new Uint8Array(docData),
          returnFileContentAfterWrite: false,
        }))
        documentFilePath = filePath
        processedSelectedDocument = new SelectedDocument({
          ...(processedSelectedDocument ?? selectedDocument),
          path: filePath,
        })
      } catch (error) {
        // The document is dropped rather than the turn: the attachment note is still there.
        logger.warn(ctx, "Failed to write document to filesystem", {
          errorType: getSafeErrorType(error),
        })
        processedSelectedDocument = undefined
      }
    }
  } else if (!docData && processedSelectedDocument && pathOnlyDocument.trustedPath !== undefined) {
    documentFilePath = pathOnlyDocument.trustedPath
  }
  // Bytes that were never written anywhere are of no use to the model, so the attachment goes.
  if (docData && documentFilePath === undefined) {
    processedSelectedDocument = undefined
  }
  return {
    selectedDocument: processedSelectedDocument,
    docData,
    mimeType: selectedDocument.mimeType,
    filename,
    documentFilePath,
  }
}
