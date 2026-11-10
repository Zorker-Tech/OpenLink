/**
 * Render attached pull-request details into bounded user context.
 */
import type {
  GitPullRequestPromptInput,
  GitPullRequestPromptSummary,
} from "./git-pr-processing-contracts.ts"

const MAX_DESCRIPTION_LENGTH = 500

interface TextContent {
  readonly type: "text"
  readonly text: string
}

export type {
  GitPullRequestPromptInput,
  GitPullRequestPromptSummary,
  GitPullRequestPromptSummaryState,
  GitPullRequestPromptFile,
} from "./git-pr-processing-contracts.ts"

export function buildGitPullRequestsUserContent(pullRequests: readonly GitPullRequestPromptInput[]): TextContent {
  if (pullRequests.length === 0) return { type: "text", text: "" }
  const descriptions = pullRequests.map(formatPullRequest).join("\n\n")
  const heading = pullRequests.length === 1 ? "Attached Pull Request:" : "Attached Pull Requests:"
  return {
    type: "text",
    text: ["<attached_pull_requests>", heading, "", descriptions, "</attached_pull_requests>"].join("\n"),
  }
}

function addFolderIndex(parts: string[], folderPath: string, hasSummary: boolean): void {
  parts.push(
    "- " + (hasSummary
      ? "Some additional details about the PR are available in the folder "
      : "PR details are available in the folder ") + folderPath,
  )
  parts.push("  - Contents:")
  parts.push("    - all.diff: Complete diff of all files in one file")
  parts.push("    - diffs/: Individual diff files if you need to read specific files")
  parts.push("    - summary.json: Metadata about the PR and changed files")
}

function appendAvailableSummary(parts: string[], summary: GitPullRequestPromptSummary, folderPath: string): void {
  if (summary.headBranch?.trim()) {
    const base = summary.baseBranch?.trim() ? " → " + summary.baseBranch : ""
    parts.push("- Branch: " + summary.headBranch + base)
  }
  if (summary.description?.trim()) {
    const description = summary.description
    parts.push(description.length > MAX_DESCRIPTION_LENGTH
      ? "- Description: " + description.slice(0, MAX_DESCRIPTION_LENGTH) +
        "... (truncated, full description in summary.json)"
      : "- Description: " + description)
  }
  if (folderPath) addFolderIndex(parts, folderPath, true)
  parts.push(
    "- Summary: " + summary.totalFiles + " files, " + summary.totalDiffLines +
      " lines, " + summary.diffCharacters + " chars",
  )

  if (summary.files === undefined || summary.files.length === 0) return
  parts.push("- Files changed:")
  for (const file of summary.files) {
    const diffFileName = file.diffFileName || file.path.replace(/\//g, "__") + ".diff"
    const fileSize = "  - " + file.path + " (diff: diffs/" + diffFileName + ")"
    let measurements = "    " + file.changeKind + ", " + file.changedLines +
      " diff lines, " + file.diffCharacters + " diff chars"
    if (file.originalCharacters !== undefined) {
      measurements += ", " + file.originalCharacters + " original chars"
    }
    parts.push(fileSize, measurements)
  }
}

function formatPullRequest(pullRequest: GitPullRequestPromptInput): string {
  const lines = ["PR #" + pullRequest.number + (pullRequest.title ? ": " + pullRequest.title : "")]
  if (pullRequest.url) lines.push("- URL: " + pullRequest.url)

  if (pullRequest.summary.kind === "available") {
    appendAvailableSummary(lines, pullRequest.summary.value, pullRequest.folderPath)
  } else if (pullRequest.summary.kind === "invalid" && pullRequest.folderPath) {
    lines.push("- PR details are available in the folder " + pullRequest.folderPath)
    lines.push("  - Read summary.json for file list and diff sizes.")
  } else if (pullRequest.summary.kind === "absent" && pullRequest.folderPath) {
    addFolderIndex(lines, pullRequest.folderPath, false)
  }
  return lines.join("\n")
}
