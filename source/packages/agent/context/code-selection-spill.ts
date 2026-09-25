/**
 * Saving a code selection too large to inline.
 *
 * A selection can be thousands of lines, and inlining it would cost more of the prompt than the rest of
 * the message together. So it is written into the project's uploads folder — the same place attachments
 * live, which is why the path is trusted later — and the message says where it went instead of carrying
 * it. The file's name keeps the original's stem and extension and adds the line range and the index, so
 * two selections from one file do not collide and the name still says what it is.
 *
 * Nothing here is worth failing a turn over: a spill that cannot happen leaves the selection to be
 * inlined after all, and the failure is logged rather than raised.
 */

import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"
import { writeExecutorResource } from "../../agent-exec/write-operation.ts"
import { WriteArgs } from "../../proto/generated/agent/v1/write_exec_pb.ts"
import type { AttachmentPathRequestContext } from "./path-trust.ts"
import { sanitizeFilename } from "../../utils/managed-paths.ts"

interface CodeSelectionWriteExecutor {
  execute(ctx: Context, args: WriteArgs): Promise<unknown>
}

export interface CodeSelectionResourceAccessor {
  get(resource: typeof writeExecutorResource): CodeSelectionWriteExecutor
}

export interface WriteCodeSelectionToFileArgs {
  readonly ctx: Context
  readonly content: string
  readonly originalPath: string
  readonly startLine: number
  readonly endLine: number
  readonly index: number
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly resourceAccessor: CodeSelectionResourceAccessor | undefined
}

const logger = createLogger("agent/context-processing")

export async function writeCodeSelectionToFile({
  ctx,
  content,
  originalPath,
  startLine,
  endLine,
  index,
  requestContext,
  resourceAccessor,
}: WriteCodeSelectionToFileArgs): Promise<{ path: string } | undefined> {
  const writeToUploadsDir = async (fileBytes: Uint8Array, safeFilename: string): Promise<{ path: string } | undefined> => {
    const projectFolder = requestContext?.env?.projectFolder
    const workspaceRootPath = requestContext?.env?.workspacePaths?.[0]
    // The project's folder when there is one, the workspace's otherwise.
    const documentRootPath = projectFolder ?? workspaceRootPath
    if (!resourceAccessor || documentRootPath === undefined) return undefined
    const filePath = path.join(documentRootPath, "uploads", safeFilename)
    const writeExecutor = resourceAccessor.get(writeExecutorResource)
    await writeExecutor.execute(ctx, new WriteArgs({
      path: filePath,
      fileBytes: new Uint8Array(fileBytes),
      returnFileContentAfterWrite: false,
    }))
    return { path: filePath }
  }

  try {
    const originalBasename = path.basename(originalPath) || "selection"
    const originalExt = path.extname(originalBasename)
    const stem = originalExt.length > 0 ? originalBasename.slice(0, -originalExt.length) : originalBasename
    const safeStem = sanitizeFilename(stem) || "selection"
    const safeExt = originalExt.length > 0 ? sanitizeFilename(originalExt.replace(/^\./, "")) || "txt" : "txt"
    const safeFilename = `${safeStem}-L${startLine}-L${endLine}-${index}.${safeExt}`
    return await writeToUploadsDir(new TextEncoder().encode(content), safeFilename)
  } catch (error) {
    logger.warn(ctx, "Failed to write long code selection to file", {
      originalPath,
      startLine,
      endLine,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
