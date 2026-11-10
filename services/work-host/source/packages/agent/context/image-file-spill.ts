/**
 * Where an attached image's file goes, so the agent can open it.
 *
 * An image is sent to the model as bytes, but the agent may also want to look at it with its own tools —
 * and that needs a path. When the image came from a file inside the workspace, the path is the file
 * itself: nothing is written and nothing is duplicated, and the agent's tools already know how to read
 * it. When it came from outside the workspace, it is written into the project's assets folder under a
 * name derived from its own — the original stem when there was one, its identifier otherwise — with an
 * extension taken from the path when it has one and from the mime type when it does not.
 *
 * The write is not waited for. The path is what the caller needs, and a write that fails leaves an image
 * the model was still given; blocking the turn on it would trade a rare inconvenience for a common delay.
 * Anything unexpected is swallowed for the same reason: a path that cannot be derived is simply absent,
 * which the caller already handles.
 */

import path from "node:path"

import type { Context } from "../../context/context.ts"
import { writeWorkspaceBytesThroughInterop, type InteropWorkspaceFileWriteAccessor } from "../../../adapters/interop/agent/workspace-file-write-adapter.ts"
import type { SlateImageAttachment } from "./image-attachment-contracts.ts"
import { sanitizeFilename } from "../../utils/managed-paths.ts"

export type ImageResourceAccessor = InteropWorkspaceFileWriteAccessor

export interface SelectedImageFilePathInput {
  readonly ctx: Context
  readonly imageData: Uint8Array | undefined
  readonly selectedImage: Pick<SlateImageAttachment, "sourcePath" | "id">
  readonly resolvedMimeType: string
  readonly index: number
  readonly enableImageFiles: boolean
  readonly requestContext: {
    readonly env?: {
      readonly projectFolder?: string | undefined
      readonly workspacePaths: readonly string[]
    } | undefined
  } | undefined
  readonly resourceAccessor: ImageResourceAccessor | undefined
}

export function writeSelectedImageToProjectAssets({
  ctx,
  imageData,
  selectedImage,
  resolvedMimeType,
  index,
  enableImageFiles,
  requestContext,
  resourceAccessor,
}: SelectedImageFilePathInput): string | undefined {
  let imageFilePath: string | undefined
  if (imageData) {
    if (
      enableImageFiles &&
      resourceAccessor &&
      requestContext?.env !== undefined &&
      requestContext.env.projectFolder !== undefined &&
      requestContext.env.projectFolder !== ""
    ) {
      try {
        const originalPath = selectedImage.sourcePath
        const extensionFromPath = originalPath !== undefined
          ? path.extname(originalPath).replace(/^\./, "").toLowerCase()
          : undefined
        // The path's own extension wins; the mime type answers when the path has none.
        let extension = "png"
        if (extensionFromPath && extensionFromPath !== "") {
          extension = extensionFromPath === "jpeg" ? "jpg" : extensionFromPath
        } else if (resolvedMimeType.includes("jpeg") || resolvedMimeType.includes("jpg")) {
          extension = "jpg"
        } else if (resolvedMimeType.includes("gif")) {
          extension = "gif"
        } else if (resolvedMimeType.includes("webp")) {
          extension = "webp"
        }
        const originalFilename = originalPath !== undefined ? path.basename(originalPath) : undefined
        const baseFilename = originalFilename !== undefined && originalFilename !== ""
          ? path.basename(originalFilename, path.extname(originalFilename))
          : selectedImage.id || `image-${Date.now()}-${index}`
        const safeBaseFilename = sanitizeFilename(baseFilename) || `image-${Date.now()}-${index}`
        const fileName = `${safeBaseFilename}.${extension}`
        const workspaceRoot = requestContext.env.workspacePaths[0]
        // An image already inside the workspace is used where it is.
        if (workspaceRoot !== undefined && originalPath !== undefined && originalPath !== "") {
          const normalizedOriginalPath = path.normalize(originalPath)
          const relativePath = path.relative(path.normalize(workspaceRoot), normalizedOriginalPath)
          if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
            imageFilePath = normalizedOriginalPath
          }
        }
        if (imageFilePath === undefined) {
          const filePath = path.join(requestContext.env.projectFolder, "assets", fileName)
          imageFilePath = filePath
          void writeWorkspaceBytesThroughInterop(resourceAccessor, ctx, filePath, imageData).catch(() => {})
        }
      } catch (_error) {
        // A path that cannot be derived is absent, which the caller already handles.
      }
    }
  }
  return imageFilePath
}
