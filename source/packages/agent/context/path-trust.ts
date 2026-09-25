/**
 * Whether a path an attachment names may be read.
 *
 * An attachment can name a file instead of carrying it, which is cheaper — the platform reads it where it
 * already is — but it also means the path came from outside: a model can write an attachment into a tool
 * call, and a path is enough to read any file the process can read. So a path-only attachment is only
 * trusted when it resolves to a place attachments are actually kept: a project's uploads, a workspace's
 * uploads, the run's artifacts folder, or the attachment storage under the project.
 *
 * Resolution is through the real path, so a symlink pointing out of an allowed directory is refused —
 * otherwise the check would only be on the spelling. A video is treated differently from a document
 * because video paths are produced by the platform rather than by the model.
 */

import { realpath } from "node:fs/promises"
import path from "node:path"

import type { Context } from "../../context/context.ts"
import { createLogger } from "../../context/logging.ts"

export interface AttachmentPathEnvironment {
  readonly projectFolder?: string | undefined
  readonly workspacePaths: readonly string[]
  readonly artifactsFolder?: string | undefined
}

export interface AttachmentPathRequestContext {
  readonly env?: AttachmentPathEnvironment | undefined
}

export type AttachmentKind = "video" | "document" | string

export interface TrustedPathOnlyAttachmentResult {
  readonly hasPathOnlyPayload: boolean
  readonly trustedPath: string | undefined
}

const logger = createLogger("agent/context-processing")

export async function resolveTrustedPathOnlyAttachmentPath(
  ctx: Context,
  readablePath: string,
  requestContext: AttachmentPathRequestContext | undefined,
  attachmentKind: AttachmentKind,
  treatNonAbsoluteAsPathOnly: boolean,
): Promise<TrustedPathOnlyAttachmentResult> {
  const hasPathOnlyPayload = readablePath.length > 0 && (treatNonAbsoluteAsPathOnly || path.isAbsolute(readablePath))
  if (!hasPathOnlyPayload) return { hasPathOnlyPayload: false, trustedPath: undefined }
  const trustedPath = await resolveTrustedPathOnlyAttachmentCandidate({ readablePath, requestContext, attachmentKind })
  if (trustedPath === undefined) {
    logger.warn(ctx, `Ignoring untrusted path-only ${attachmentKind} attachment`)
  }
  return { hasPathOnlyPayload: true, trustedPath }
}

function isPathWithinPrefix({ targetPath, prefix }: { targetPath: string; prefix: string }): boolean {
  const resolvedTarget = path.resolve(targetPath)
  const resolvedPrefix = path.resolve(prefix)
  return resolvedTarget === resolvedPrefix || resolvedTarget.startsWith(resolvedPrefix + path.sep)
}

function isPathWithinAnyPrefix(targetPath: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => isPathWithinPrefix({ targetPath, prefix }))
}

/** The platform's own attachment storage: `<project>/attachments/<kind>/<name>`. */
function isAttachmentStoragePath(targetPath: string, projectFolder: string | undefined): boolean {
  if (projectFolder === undefined) return false
  if (!isPathWithinPrefix({ targetPath, prefix: projectFolder })) return false
  const relativePath = path.relative(path.resolve(projectFolder), path.resolve(targetPath))
  const segments = relativePath.split(path.sep).filter(Boolean)
  return segments.length >= 3 && segments[0] === "attachments" &&
    segments[1] !== undefined && segments[2] !== undefined
}

async function resolveCanonicalAttachmentPath(targetPath: string): Promise<string | undefined> {
  try {
    return await realpath(targetPath)
  } catch {
    return undefined
  }
}

async function getTrustedSelectedDocumentPath(
  documentPath: string,
  requestContext: AttachmentPathRequestContext | undefined,
): Promise<string | undefined> {
  const canonicalPath = await resolveCanonicalAttachmentPath(documentPath)
  if (canonicalPath === undefined) return undefined
  const env = requestContext?.env
  const allowedPrefixes = [
    env?.projectFolder ? path.join(env.projectFolder, "uploads") : undefined,
    ...(env?.workspacePaths.map(workspacePath => path.join(workspacePath, "uploads")) ?? []),
    env?.artifactsFolder,
  ].filter((prefix): prefix is string => prefix !== undefined)
  const isTrusted = isPathWithinAnyPrefix(canonicalPath, allowedPrefixes) ||
    isAttachmentStoragePath(canonicalPath, env?.projectFolder)
  return isTrusted ? canonicalPath : undefined
}

async function resolveTrustedPathOnlyAttachmentCandidate({ readablePath, requestContext, attachmentKind }: {
  readonly readablePath: string
  readonly requestContext: AttachmentPathRequestContext | undefined
  readonly attachmentKind: AttachmentKind
}): Promise<string | undefined> {
  if (!path.isAbsolute(readablePath)) return undefined
  // A video path is produced by the platform, so it is taken as given.
  if (attachmentKind === "video") return path.resolve(readablePath)
  return getTrustedSelectedDocumentPath(readablePath, requestContext)
}
