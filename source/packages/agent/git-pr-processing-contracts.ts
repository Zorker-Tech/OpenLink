export interface GitPullRequestPromptFile {
  readonly path: string
  readonly diffFileName?: unknown
  readonly changeKind: unknown
  readonly changedLines: unknown
  readonly diffCharacters: unknown
  readonly originalCharacters?: unknown
}

export interface GitPullRequestPromptSummary {
  readonly headBranch?: string
  readonly baseBranch?: string
  readonly description?: string
  readonly totalFiles: unknown
  readonly totalDiffLines: unknown
  readonly diffCharacters: unknown
  readonly files?: readonly GitPullRequestPromptFile[]
}

export type GitPullRequestPromptSummaryState =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly value: GitPullRequestPromptSummary }

export interface GitPullRequestPromptInput {
  readonly number: number
  readonly url: string
  readonly folderPath: string
  readonly title?: string
  readonly summary: GitPullRequestPromptSummaryState
}
