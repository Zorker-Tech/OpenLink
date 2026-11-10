import { AgentType } from "../utils/agent-config.ts"
import { sanitizeRemoteUrlForPrompt } from "./remote-url-sanitizing.ts"
import type { UserInfoGitRepository } from "./user-info-data-contracts.ts"

interface GitStatusToolInfo {
  readonly allTools: Record<string, unknown>
}

export interface GitStatusProjectionInput {
  readonly gitRepos: readonly UserInfoGitRepository[]
  readonly gitReposWithStatus: readonly UserInfoGitRepository[]
  readonly initialWorkingDirectory?: string | undefined
  readonly agentType?: AgentType | undefined
  readonly toolInfo?: GitStatusToolInfo | undefined
}

export interface GitStatusRepositoryProjection {
  readonly path: string
  readonly statusBlock?: string | undefined
  readonly remoteUrl?: string | undefined
}

export interface GitStatusProjection {
  readonly notes: readonly string[]
  readonly repositories: readonly GitStatusRepositoryProjection[]
}

const MAX_STATUS_CHARS = 10_000
const CODE_FENCE = String.fromCharCode(96).repeat(3)
const STATUS_NOTE = "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation."

function boundStatus(status: string): string {
  if (status.length <= MAX_STATUS_CHARS) return status
  const cut = status.slice(0, MAX_STATUS_CHARS)
  const lastLineBoundary = cut.lastIndexOf("\n")
  const visible = lastLineBoundary > 0 ? cut.slice(0, lastLineBoundary) : cut
  return visible + "\n\n... (git status truncated)"
}

function codeBlock(status: string): string {
  const visible = boundStatus(status).trim()
  return visible.length === 0 ? "" : CODE_FENCE + "\n" + visible + "\n" + CODE_FENCE
}

function repositoriesWithoutDuplicatePaths(
  allRepositories: readonly UserInfoGitRepository[],
  repositoriesWithStatus: readonly UserInfoGitRepository[],
): readonly UserInfoGitRepository[] {
  const alreadyListed = new Set(repositoriesWithStatus.map(repository => repository.path))
  return [
    ...repositoriesWithStatus,
    ...allRepositories.filter(repository =>
      !alreadyListed.has(repository.path) &&
      repository.remoteUrl !== undefined &&
      repository.remoteUrl.trim().length > 0),
  ]
}

export function projectGitStatusSection(input: GitStatusProjectionInput): GitStatusProjection {
  const cloudWorkspace = input.agentType === AgentType.BACKGROUND && input.gitRepos.length > 1
  const includeRemotes = cloudWorkspace && input.toolInfo?.allTools.PR_MANAGEMENT !== undefined
  const statusPaths = new Set(input.gitReposWithStatus.map(repository => repository.path))
  const source = includeRemotes
    ? repositoriesWithoutDuplicatePaths(input.gitRepos, input.gitReposWithStatus)
    : input.gitReposWithStatus
  const repositories = source.map(repository => {
    const remoteUrl = includeRemotes && repository.remoteUrl !== undefined && repository.remoteUrl.trim().length > 0
      ? sanitizeRemoteUrlForPrompt(repository.remoteUrl)
      : undefined
    return {
      path: repository.path,
      ...(statusPaths.has(repository.path) ? { statusBlock: codeBlock(repository.status) } : {}),
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
    }
  })

  const notes = [STATUS_NOTE]
  if (cloudWorkspace) {
    const workingDirectory = input.initialWorkingDirectory?.trim()
    notes.push(workingDirectory === undefined || workingDirectory.length === 0
      ? "This cloud workspace has multiple independent git repositories, each listed below with its own status."
      : "This cloud workspace has multiple independent git repositories, each listed below with its own status. The agent process initial working directory is " + workingDirectory + ".")
  }
  return { notes, repositories }
}
