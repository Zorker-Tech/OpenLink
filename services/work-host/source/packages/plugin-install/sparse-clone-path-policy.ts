import { posix, win32 } from "node:path"

export type MaterializeSpec = "all" | string[]

function safeRepositoryDirectory(rawPath: string): string | undefined {
  const slashPath = rawPath.trim().replace(/\\/g, "/")
  const withoutCurrentDirectory = slashPath.replace(/^(?:\.\/)+/, "")
  const candidate = withoutCurrentDirectory.replace(/\/+$/, "")
  if (candidate === "" || candidate === "." || posix.isAbsolute(candidate) || win32.isAbsolute(candidate) || /^[a-z]:/i.test(candidate)) return undefined

  const parts = candidate.split("/")
  if (parts.some(part => part === "" || part === "." || part === "..")) return undefined
  return parts.join("/")
}

/** Turn plugin paths into safe checkout directories; one unsafe path widens the request to the full tree. */
export function materializeSpecForGitPaths(gitPaths: readonly string[]): MaterializeSpec {
  const safePaths = gitPaths.map(safeRepositoryDirectory)
  if (safePaths.some(path => path === undefined)) return "all"
  return safePaths as string[]
}

/** Keep the roots that contain marketplace manifests, then add requested content without repeating a directory. */
export function initialSparseDirectories(
  requestedDirectories: readonly string[],
  manifestPaths: readonly string[],
): string[] {
  const requiredRoots = manifestPaths.flatMap(path => {
    const slash = path.indexOf("/")
    return slash > 0 ? [path.slice(0, slash)] : []
  })
  const directories = new Set(requiredRoots)
  for (const directory of requestedDirectories) directories.add(directory)
  return [...directories]
}

/** Detect the message git emits when a remote accepts a fetch but ignores its object filter. */
export function serverIgnoredFilter(stderr: string): boolean {
  return stderr.toLowerCase().includes("filtering not recognized by server")
}
