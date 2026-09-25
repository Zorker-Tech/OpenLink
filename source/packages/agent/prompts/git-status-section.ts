/**
 * The git state of the workspace when the conversation started.
 *
 * The agent needs to know what it is working in before it changes anything, and the status is the
 * cheapest way to tell it. Two things make the section more than a dump: the status is capped (a
 * repository with a hundred thousand characters of pending changes would otherwise be most of the
 * prompt), and the cap is taken at a line boundary so the last entry shown is not half a line.
 *
 * A cloud workspace can hold several independent repositories, which changes the reading — "the repo"
 * is not one thing — so that case is named, together with where the agent process starts. Remote URLs
 * are shown only there, and only when the agent can act on them; they are sanitized on the way in
 * because a remote may carry credentials.
 */

import { AgentType } from "../utils/agent-config.ts"
import { Fragment, jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"
import type { GitRepoInfo } from "../../proto/generated/agent/v1/request_context_exec_pb.ts"
import { sanitizeRemoteUrlForPrompt } from "./remote-url-sanitizing.ts"

interface GitStatusToolInfo {
  readonly allTools: Record<string, unknown>
}

const GIT_STATUS_CHARACTER_LIMIT = 10_000

function truncateGitStatus(status: string): string {
  if (!status) return ""
  if (status.length <= GIT_STATUS_CHARACTER_LIMIT) return status
  let truncated = status.slice(0, GIT_STATUS_CHARACTER_LIMIT)
  const lastNewlineIndex = truncated.lastIndexOf("\n")
  if (lastNewlineIndex > 0) truncated = truncated.slice(0, lastNewlineIndex)
  return `${truncated}

... (git status truncated)`
}

function wrapGitStatusInCodeFence(status: string): string {
  const trimmed = status.trim()
  if (trimmed === "") return ""
  return `\`\`\`
${trimmed}
\`\`\``
}

/** Repositories with no status are still listed when they have a remote worth naming. */
function deduplicateRepos(
  gitRepos: readonly GitRepoInfo[],
  gitReposWithStatus: readonly GitRepoInfo[],
): readonly GitRepoInfo[] {
  const statusPaths = new Set(gitReposWithStatus.map(repo => repo.path))
  const extras = gitRepos.filter(repo =>
    !statusPaths.has(repo.path) && repo.remoteUrl !== undefined && repo.remoteUrl.trim() !== "")
  return [...gitReposWithStatus, ...extras]
}

export function GitStatusSection({ gitRepos, gitReposWithStatus, initialWorkingDirectory, agentType, toolInfo }: {
  readonly gitRepos: readonly GitRepoInfo[]
  readonly gitReposWithStatus: readonly GitRepoInfo[]
  readonly initialWorkingDirectory?: string | undefined
  readonly agentType?: AgentType | undefined
  readonly toolInfo?: GitStatusToolInfo | undefined
}): PromptNode {
  const statusNote = "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation."
  const initialWd = initialWorkingDirectory !== undefined && initialWorkingDirectory.trim() !== ""
    ? initialWorkingDirectory.trim()
    : undefined
  const cloudMultiRepoFirstSentence = agentType === AgentType.BACKGROUND && gitRepos.length > 1
    ? "This cloud workspace has multiple independent git repositories, each listed below with its own status."
    : undefined
  const cloudMultiRepoExplanation = cloudMultiRepoFirstSentence !== undefined
    ? initialWd !== undefined
      ? `${cloudMultiRepoFirstSentence} The agent process initial working directory is ${initialWd}.`
      : cloudMultiRepoFirstSentence
    : undefined
  const isCloudMultiRepo = agentType === AgentType.BACKGROUND && gitRepos.length > 1
  const shouldShowRemoteUrls = isCloudMultiRepo && toolInfo?.allTools.PR_MANAGEMENT !== undefined
  const reposWithStatusPaths = new Set(gitReposWithStatus.map(repo => repo.path))
  const reposToDisplay = shouldShowRemoteUrls ? deduplicateRepos(gitRepos, gitReposWithStatus) : gitReposWithStatus
  return jsxs("section", {
    title: "git_status",
    children: [
      jsx("p", { children: statusNote }),
      cloudMultiRepoExplanation !== undefined && jsx("p", { children: cloudMultiRepoExplanation }),
      reposToDisplay.map((repo, index) => {
        const remoteUrl = shouldShowRemoteUrls && repo.remoteUrl !== undefined && repo.remoteUrl.trim() !== ""
          ? sanitizeRemoteUrlForPrompt(repo.remoteUrl)
          : undefined
        const hasStatus = reposWithStatusPaths.has(repo.path)
        return jsxs(Fragment, {
          children: [
            index > 0 && jsx("br", {}),
            jsx("br", {}),
            jsxs("p", { children: ["Git repo: ", repo.path, remoteUrl !== undefined && ` (remote: ${remoteUrl})`] }),
            hasStatus && wrapGitStatusInCodeFence(truncateGitStatus(repo.status)),
          ],
        })
      }),
    ],
  })
}
