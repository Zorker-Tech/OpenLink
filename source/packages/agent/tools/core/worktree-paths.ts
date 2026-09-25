/**
 * A misspelling in a path that has been seen in the wild.
 *
 * A worktree directory was once written as `worktries` in a path the platform hands around, and paths
 * that carry it do not exist — so a tool asked to read one fails with "no such file" for a reason nobody
 * can see. The correction is applied on the way in, and kept behind a switch so it can be turned off
 * once nothing produces the misspelling any more.
 */

const ENABLED = true
const MISSPELLED_WORKTREES_REGEX = /(^\/(?:Users|home)\/[^/]+\/\.cursor\/)worktries(?=\/|$)/g

export function maybeRedirectWorktriesPath(originalPath: string): string {
  if (!ENABLED) return originalPath
  return originalPath.replace(MISSPELLED_WORKTREES_REGEX, "$1worktrees")
}
