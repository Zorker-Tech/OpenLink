import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import { findSystemErrno } from "../system-errno.ts"
import { isPathWithin } from "./path-boundary-policy.ts"

export async function realpathNearestExisting(path: string): Promise<string> {
  const missingSegments: string[] = []
  let candidate = path

  for (;;) {
    try {
      const resolvedExistingPath = await realpath(candidate)
      return missingSegments.length === 0
        ? resolvedExistingPath
        : join(resolvedExistingPath, ...missingSegments.reverse())
    } catch (error) {
      if (findSystemErrno(error) !== "ENOENT") throw error
      const parent = dirname(candidate)
      if (parent === candidate) return path
      missingSegments.push(basename(candidate))
      candidate = parent
    }
  }
}

export async function containWithin(roots: readonly string[], path: unknown): Promise<string | null> {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) return null
  const resolvedPath = resolve(path)
  if (!roots.some((root) => isPathWithin(root, resolvedPath))) return null

  const [realPath, realRoots] = await Promise.all([
    realpathNearestExisting(resolvedPath),
    Promise.all(roots.map((root) => realpathNearestExisting(root))),
  ])
  return realRoots.some((root) => isPathWithin(root, realPath)) ? resolvedPath : null
}
