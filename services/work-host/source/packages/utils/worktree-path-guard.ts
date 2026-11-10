import path from "node:path"

export const WORKTREE_GUARD_ERROR = "You cannot search other worktrees for this repository, stay within your workspace paths."
export const WORKTREES_SEGMENT = ".slate/worktrees"

export function normalizeToUnixPath(value: string): string {
  return value.replace(/\\/g, "/")
}

export function isWorktreesPath(value: string): boolean {
  return normalizeToUnixPath(value).includes(WORKTREES_SEGMENT)
}

export function isPathWithin({ basePath, targetPath }: { basePath: string; targetPath: string }): boolean {
  const root = path.resolve(basePath)
  const candidate = path.resolve(root, targetPath)
  const rootVolume = path.parse(root).root
  if (root === rootVolume) {
    return path.parse(candidate).root === rootVolume && (candidate === root || candidate.length > root.length)
  }
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function worktreeRepositoryRoot(worktreePath: string): string | undefined {
  const normalized = normalizeToUnixPath(worktreePath)
  const marker = `/${WORKTREES_SEGMENT}/`
  const markerStart = normalized.indexOf(marker)
  if (markerStart < 0) return undefined
  const repositoryName = normalized.slice(markerStart + marker.length).split("/")[0] ?? ""
  return repositoryName.length === 0
    ? undefined
    : normalized.slice(0, markerStart + marker.length + repositoryName.length)
}

export function shouldBlockWorktreePath(params: {
  targetPath?: string | undefined
  workspacePaths: readonly string[]
  mainWorktreePath?: string | undefined
}): boolean {
  const { targetPath, workspacePaths, mainWorktreePath } = params
  if (targetPath === undefined || workspacePaths.length === 0) return false
  if (!workspacePaths.every(isWorktreesPath)) return false
  if (workspacePaths.some((workspace) => isPathWithin({ basePath: workspace, targetPath }))) return false

  const resolvedTargets = path.isAbsolute(targetPath)
    ? [path.resolve(targetPath)]
    : workspacePaths.map((workspace) => path.resolve(workspace, targetPath))
  const repositoryRoots = workspacePaths
    .map(worktreeRepositoryRoot)
    .filter((candidate): candidate is string => candidate !== undefined)
  return resolvedTargets.some((candidate) =>
    repositoryRoots.some((root) => isPathWithin({ basePath: root, targetPath: candidate })) ||
    (mainWorktreePath !== undefined && isPathWithin({ basePath: mainWorktreePath, targetPath: candidate })),
  )
}
