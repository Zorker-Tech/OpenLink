import type { SelectedPullRequest } from "../proto/generated/agent/v1/selected_context_pb.ts"
import type {
  GitPullRequestPromptFile,
  GitPullRequestPromptInput,
  GitPullRequestPromptSummary,
  GitPullRequestPromptSummaryState,
} from "../../../packages/agent/git-pr-processing-contracts.ts"

type JsonRecord = Record<string, unknown>

function recordOf(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function optionalText(record: JsonRecord, key: string): { valid: boolean; value?: string } {
  const value = record[key]
  if (value == null) return { valid: true }
  return typeof value === "string" ? { valid: true, value } : { valid: false }
}

function promptFile(value: unknown): GitPullRequestPromptFile | undefined {
  const record = recordOf(value)
  if (record === undefined || typeof record.path !== "string") return undefined
  return {
    path: record.path,
    ...(record.diffFileName === undefined ? {} : { diffFileName: record.diffFileName }),
    changeKind: record.status,
    changedLines: record.diffLines,
    diffCharacters: record.diffSizeChars ?? record.diffSizeBytes,
    ...(record.originalSizeChars === undefined && record.originalSizeBytes === undefined
      ? {}
      : { originalCharacters: record.originalSizeChars ?? record.originalSizeBytes }),
  }
}

function summaryFromJson(summaryJson: string | undefined): GitPullRequestPromptSummaryState {
  if (summaryJson === undefined || summaryJson.length === 0) return { kind: "absent" }

  let decoded: unknown
  try {
    decoded = JSON.parse(summaryJson)
  } catch {
    return { kind: "invalid" }
  }

  const record = recordOf(decoded)
  if (record === undefined) return { kind: "invalid" }
  const head = optionalText(record, "headRef")
  const base = optionalText(record, "baseRef")
  const description = optionalText(record, "description")
  if (!head.valid || !base.valid || !description.valid) return { kind: "invalid" }

  let files: GitPullRequestPromptFile[] | undefined
  if (Array.isArray(record.files)) {
    files = []
    for (const file of record.files) {
      const projected = promptFile(file)
      if (projected === undefined) return { kind: "invalid" }
      files.push(projected)
    }
  } else if (record.files != null) {
    const length = recordOf(record.files)?.length
    if (typeof length === "number" && length > 0) return { kind: "invalid" }
  }

  const summary: GitPullRequestPromptSummary = {
    ...(head.value === undefined ? {} : { headBranch: head.value }),
    ...(base.value === undefined ? {} : { baseBranch: base.value }),
    ...(description.value === undefined ? {} : { description: description.value }),
    totalFiles: record.totalFiles,
    totalDiffLines: record.totalDiffLines,
    diffCharacters: record.totalDiffSizeChars ?? record.totalDiffSizeBytes,
    ...(files === undefined ? {} : { files }),
  }
  return { kind: "available", value: summary }
}

export function projectSelectedPullRequestsForPrompt(
  selected: readonly SelectedPullRequest[],
): GitPullRequestPromptInput[] {
  return selected.map(pullRequest => ({
    number: pullRequest.number,
    url: pullRequest.url,
    folderPath: pullRequest.folderPath,
    ...(pullRequest.title === undefined ? {} : { title: pullRequest.title }),
    summary: summaryFromJson(pullRequest.summaryJson),
  }))
}
