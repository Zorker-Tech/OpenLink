import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface PathWithinOptions {
  readonly isInclusive?: boolean
}

export function isPathWithin(parent: string, child: string, options: PathWithinOptions = {}): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  if (relativePath === "") return options.isInclusive ?? false
  return !relativePath.startsWith("..") && !isAbsolute(relativePath)
}

export function filePathFromFileUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : null
  } catch {
    return null
  }
}

export function posixPathFromFileUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === "file:" ? decodeURIComponent(parsed.pathname) : null
  } catch {
    return null
  }
}
