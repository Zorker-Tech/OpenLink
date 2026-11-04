import { realpath } from "node:fs/promises"
import path from "node:path"

export function isWithinResolvedPrefix(target: string, prefix: string): boolean {
  const targetPath = path.resolve(target)
  const prefixPath = path.resolve(prefix)
  return targetPath === prefixPath || targetPath.startsWith(`${prefixPath}${path.sep}`)
}

export function isInProjectAttachmentTree(target: string, projectFolder: string | undefined): boolean {
  if (projectFolder === undefined || !isWithinResolvedPrefix(target, projectFolder)) return false
  const relative = path.relative(path.resolve(projectFolder), path.resolve(target))
  const components = relative.split(path.sep).filter(part => part.length > 0)
  return components.length >= 3 && components[0] === "attachments"
}

export async function resolveRealAttachmentPath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}
