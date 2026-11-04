import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function expandHomeAlias(value: string): string {
  return value.replace(/^~(?=$|\/|\\)/, homedir())
}

function fileUrlPathOrOriginal(value: string): string {
  if (!value.startsWith("file://")) return value
  try {
    return fileURLToPath(value)
  } catch {
    return value
  }
}

export function resolvePath(value: string, basePath?: string): string {
  const input = expandHomeAlias(fileUrlPathOrOriginal(value))
  return basePath !== undefined && basePath.length > 0 && !path.isAbsolute(input)
    ? path.resolve(basePath, input)
    : path.resolve(input)
}

/** Follow the longest existing prefix, then append the not-yet-created path remainder. */
export async function resolveRealPathStrict(value: string, basePath?: string): Promise<string | null> {
  const requested = resolvePath(value, basePath)
  let ancestor = requested

  while (true) {
    try {
      const actual = await realpath(ancestor)
      return path.resolve(actual, path.relative(ancestor, requested))
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") return null
      const parent = path.dirname(ancestor)
      if (parent === ancestor) return requested
      ancestor = parent
    }
  }
}
