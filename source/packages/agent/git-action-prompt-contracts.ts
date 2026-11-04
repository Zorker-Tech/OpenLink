export type GitActionPromptReason =
  | "diff-tab-commit"
  | "diff-tab-commit-and-push"
  | "diff-tab-push"
  | "diff-tab-create-pr"
  | "diff-tab-create-branch"
  | "diff-tab-fix-merge-conflicts"
  | "babysit-pr-in-cloud"
  | "multitask-split-prs"
  | "apply-locally"
  | "checkout-branch"

export interface GitActionBranchContext {
  readonly currentBranch?: string | undefined
  readonly baseBranch?: string | undefined
  readonly agentBranchPrefix?: string | undefined
}

export interface PullRequestTemplateHint {
  readonly filePath?: string | undefined
  readonly directoryPath?: string | undefined
}

export interface GitActionFileStatus {
  readonly path: string
  readonly status?: string | undefined
}

export interface GitCommitPromptData {
  readonly filesToCommit: readonly string[]
  readonly filesToCommitWithStatus: readonly GitActionFileStatus[]
  readonly filesToExcludeFromCommit: readonly string[]
  readonly filesToExcludeFromCommitWithStatus: readonly GitActionFileStatus[]
  readonly shouldStageAllChanges: boolean
  readonly createPrDraft?: boolean | undefined
}

export type GitActionPromptSelection =
  | { readonly kind: "commit"; readonly params: GitCommitPromptData; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "commit-and-push"; readonly params: GitCommitPromptData; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "create-branch-and-commit"; readonly params: GitCommitPromptData; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "create-branch-commit-and-push"; readonly params: GitCommitPromptData; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "create-branch"; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "create-pr-with-changes"; readonly params: GitCommitPromptData; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "push"; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "create-pr"; readonly draft?: boolean | undefined; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "fix-merge-conflicts"; readonly baseBranch?: string | undefined; readonly prUrl?: string | undefined; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "babysit-pr"; readonly baseBranch?: string | undefined; readonly branchContext?: GitActionBranchContext | undefined }
  | { readonly kind: "apply-locally"; readonly remoteBranch: string }
  | { readonly kind: "checkout-branch"; readonly remoteBranch: string }

export interface GitActionPromptInput {
  readonly reason: GitActionPromptReason
  readonly action?: GitActionPromptSelection | undefined
  readonly template?: PullRequestTemplateHint | undefined
  readonly environmentParamForSubagent?: boolean | undefined
  readonly babysitV2Prompt?: boolean | undefined
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}
