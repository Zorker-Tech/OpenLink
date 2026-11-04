import path from "node:path"

import type { AttachmentKind, AttachmentPathRequestContext } from "./path-trust-contracts.ts"
import { isInProjectAttachmentTree, isWithinResolvedPrefix, resolveRealAttachmentPath } from "./path-trust-guards.ts"

export async function resolveTrustedAttachmentCandidate(
  readablePath: string,
  requestContext: AttachmentPathRequestContext | undefined,
  attachmentKind: AttachmentKind,
): Promise<string | undefined> {
  if (!path.isAbsolute(readablePath)) return undefined
  if (attachmentKind === "video") return path.resolve(readablePath)

  const canonicalPath = await resolveRealAttachmentPath(readablePath)
  if (canonicalPath === undefined) return undefined
  const env = requestContext?.env
  const allowedRoots = [
    ...(env?.projectFolder === undefined ? [] : [path.join(env.projectFolder, "uploads")]),
    ...(env?.workspacePaths.map(workspacePath => path.join(workspacePath, "uploads")) ?? []),
    ...(env?.artifactsFolder === undefined ? [] : [env.artifactsFolder]),
  ]
  const livesInAllowedRoot = allowedRoots.some(root => isWithinResolvedPrefix(canonicalPath, root))
  const isProjectAttachment = isInProjectAttachmentTree(canonicalPath, env?.projectFolder)
  return livesInAllowedRoot || isProjectAttachment ? canonicalPath : undefined
}
