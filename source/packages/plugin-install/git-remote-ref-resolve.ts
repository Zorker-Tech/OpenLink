import { execGitNonInteractive } from "./git-command.ts"
import type { PluginSourceRevision, PluginSourceRevisionOptions } from "./git-ref-resolution-contracts.ts"
import { isCommitPrefix, isFullCommitId, selectResolvedCommit } from "./git-ref-resolution-policy.ts"

export { isCommitPrefix, isFullCommitId, parseRemoteCommitRecords, selectResolvedCommit } from "./git-ref-resolution-policy.ts"
export type { PluginSourceRevision, PluginSourceRevisionOptions } from "./git-ref-resolution-contracts.ts"

async function resolveNamedHexRef(
  gitUrl: string,
  ref: string,
  options?: PluginSourceRevisionOptions,
): Promise<string | undefined> {
  const response = await execGitNonInteractive(
    ["ls-remote", gitUrl, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    options,
  )
  return selectResolvedCommit(response.stdout)
}

/** Resolves a plugin manifest revision to the immutable commit that fetches should use. */
export async function resolvePluginSourceRevision(
  gitUrl: string,
  requestedRef: string,
  options?: PluginSourceRevisionOptions,
): Promise<PluginSourceRevision> {
  const ref = requestedRef.trim()
  if (isFullCommitId(ref)) return { fullSha: ref.toLowerCase() }

  if (isCommitPrefix(ref)) {
    try {
      const namedCommit = await resolveNamedHexRef(gitUrl, ref, options)
      if (namedCommit !== undefined) return { fullSha: namedCommit }
    } catch {
      // A short object id remains useful when the remote cannot be queried for same-named refs.
    }
    return { fullSha: ref.toLowerCase() }
  }

  let stdout: string
  try {
    if (ref.toUpperCase() === "HEAD") {
      const response = await execGitNonInteractive(["ls-remote", "--symref", gitUrl, "HEAD"], options)
      const commit = selectResolvedCommit(response.stdout)
      if (commit === undefined) throw new Error(`The remote did not provide a commit for its default branch (${gitUrl}).`)
      return { fullSha: commit, headSymrefStdout: response.stdout }
    }
    ({ stdout } = await execGitNonInteractive(["ls-remote", gitUrl, ref], options))
  } catch (error) {
    const wrapped = new Error(
      `Could not resolve plugin revision "${ref}" from ${gitUrl}: ${error instanceof Error ? error.message : String(error)}`,
    )
    wrapped.cause = error
    throw wrapped
  }

  const commit = selectResolvedCommit(stdout)
  if (commit === undefined) throw new Error(`The remote did not resolve plugin revision "${ref}" to a commit (${gitUrl}).`)
  return { fullSha: commit }
}
