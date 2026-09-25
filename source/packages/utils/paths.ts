/**
 * Turning what a user typed into a path, and deciding whether a path is inside the workspace.
 *
 * Paths arrive as `~`-relative, as `file://` URLs, or relative to a workspace root, and they have to
 * be resolved before anything is read or written. The workspace guard exists because a worktree
 * checkout shares a repository with its siblings: searching outside the workspace would read another
 * branch's files, which looks like corruption to whoever is working there.
 */

import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const WORKTREE_GUARD_ERROR =
  "You cannot search other worktrees for this repository, stay within your workspace paths."

/** Where worktree checkouts live inside a workspace, relative to the workspace root. */
export const WORKTREES_SEGMENT = ".slate/worktrees"

function untildify(value: string): string {
  return value.replace(/^~(?=$|\/|\\)/, homedir())
}

function stripFileUrlIfPresent(value: string): string {
  if (!value.startsWith("file://")) return value
  try {
    return fileURLToPath(value)
  } catch {
    return value
  }
}

export function resolvePath(value: string, basePath?: string): string {
  const untildified = untildify(stripFileUrlIfPresent(value))
  if (basePath && !path.isAbsolute(untildified)) return path.resolve(basePath, untildified)
  return path.resolve(untildified)
}

/**
 * Resolves symlinks without requiring the path to exist: the longest existing prefix is resolved and
 * the rest is appended, so a file that is about to be created still gets a real path.
 */
export async function resolveRealPathStrict(value: string, basePath?: string): Promise<string | null> {
  const normalized = resolvePath(value, basePath)
  let current = normalized
  while (true) {
    try {
      const resolved = await realpath(current)
      return path.resolve(resolved, path.relative(current, normalized))
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") return null
      const parent = path.dirname(current)
      if (parent === current) return normalized
      current = parent
    }
  }
}

export function isPathWithin({ basePath, targetPath }: { basePath: string; targetPath: string }): boolean {
  const resolvedBase = path.resolve(basePath)
  const resolvedTarget = path.resolve(basePath, targetPath)
  if (resolvedBase === path.parse(resolvedBase).root) {
    return path.parse(resolvedTarget).root === resolvedBase &&
      (resolvedTarget === resolvedBase || resolvedTarget.length > resolvedBase.length)
  }
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep)
}

function isPathWithinAnyRoot(targetPath: string, roots: readonly string[]): boolean {
  return roots.some(root => isPathWithin({ basePath: root, targetPath }))
}

export function normalizeToUnixPath(value: string): string {
  return value.replace(/\\/g, "/")
}

export function isWorktreesPath(value: string): boolean {
  return normalizeToUnixPath(value).includes(WORKTREES_SEGMENT)
}

/** `…/.slate/worktrees/<repo>/<worktree>` → the checkout of `<repo>` that owns it. */
function getWorktreesRepoRoot(worktreePath: string): string | undefined {
  const normalized = normalizeToUnixPath(worktreePath)
  const marker = `/${WORKTREES_SEGMENT}/`
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) return undefined
  const parts = normalized.slice(markerIndex + marker.length).split("/")
  const repoName = parts[0] ?? ""
  if (repoName.length === 0) return undefined
  return normalized.slice(0, markerIndex + marker.length + repoName.length)
}

/**
 * A path is blocked when every workspace root is a worktree checkout, the path leaves those roots,
 * and it lands in another checkout of the same repository — its siblings, or the main worktree.
 */
export function shouldBlockWorktreePath(params: {
  targetPath?: string | undefined
  workspacePaths: readonly string[]
  mainWorktreePath?: string | undefined
}): boolean {
  const { targetPath, workspacePaths, mainWorktreePath } = params
  if (targetPath === undefined) return false
  if (workspacePaths.length === 0) return false
  if (!workspacePaths.every(workspacePath => isWorktreesPath(workspacePath))) return false
  if (isPathWithinAnyRoot(targetPath, workspacePaths)) return false

  const resolvedTargets = path.isAbsolute(targetPath)
    ? [path.resolve(targetPath)]
    : workspacePaths.map(workspacePath => path.resolve(workspacePath, targetPath))
  const repoRoots = workspacePaths
    .map(root => getWorktreesRepoRoot(root))
    .filter((root): root is string => root !== undefined)
  if (repoRoots.length > 0 && resolvedTargets.some(target => isPathWithinAnyRoot(target, repoRoots))) return true
  if (mainWorktreePath !== undefined && resolvedTargets.some(target => isPathWithinAnyRoot(target, [mainWorktreePath]))) return true
  return false
}
