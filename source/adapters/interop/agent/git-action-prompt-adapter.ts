import {
  SimulatedMsgReason,
  type SimulatedMsgReason as InteropSimulatedMsgReason,
} from "../proto/generated/agent/v1/agent_pb.ts"
import type {
  SelectedAgenticGitAction,
  SelectedAgenticGitActionCommitParams,
  SelectedContext,
} from "../proto/generated/agent/v1/selected_context_pb.ts"
import {
  type GitActionBranchContext,
  type GitActionPromptInput,
  type GitActionPromptReason,
  type GitActionPromptSelection,
  type GitCommitPromptData,
} from "../../../packages/agent/git-action-prompt-contracts.ts"
import type { TaskToolModelInfo } from "../../../packages/agent/tools/task-tool-name.ts"
import { synthesizeGitActionPrompt } from "../../../packages/agent/git-action-prompt.ts"
import { renderSimulatedMessagePrompts, type SimulatedMessagePromptText } from "../../../packages/agent/simulated-message-prompts.ts"
import { SlateSimulatedMessageReason, type SlateSimulatedMessageReason as SlateSimulatedReason } from "../../../packages/agent/user-message-state.ts"
import type { SlateRepositoryActionSelection, SlateRepositoryCommitIntent, SlateContextText } from "../../../packages/agent/context/selected-context-state.ts"
import { RedactedString } from "../../../packages/redaction/redacted-values.ts"
import { PrivacyCapability } from "../../../packages/redaction/classification.ts"
import { toInteropSimulatedMessageReason } from "./user-message-action-protocol-adapter.ts"
import { multitaskActionForReason } from "./multitask-action-reason-adapter.ts"

export interface InteropGitActionPromptInput {
  readonly selectedContext: SelectedContext
  readonly simulatedMsgReason: InteropSimulatedMsgReason
  readonly environmentParamForSubagent?: boolean | undefined
  readonly babysitV2Prompt?: boolean | undefined
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}

export interface InteropSimulatedPromptInput extends InteropGitActionPromptInput {
  readonly modelInfo?: TaskToolModelInfo | undefined
}

function projectPromptReason(reason: InteropSimulatedMsgReason): GitActionPromptReason | undefined {
  if (reason === SimulatedMsgReason.DIFF_TAB_COMMIT) return "diff-tab-commit"
  if (reason === SimulatedMsgReason.DIFF_TAB_COMMIT_AND_PUSH) return "diff-tab-commit-and-push"
  if (reason === SimulatedMsgReason.DIFF_TAB_PUSH) return "diff-tab-push"
  if (reason === SimulatedMsgReason.DIFF_TAB_CREATE_PR) return "diff-tab-create-pr"
  if (reason === SimulatedMsgReason.DIFF_TAB_CREATE_BRANCH) return "diff-tab-create-branch"
  if (reason === SimulatedMsgReason.DIFF_TAB_FIX_MERGE_CONFLICTS) return "diff-tab-fix-merge-conflicts"
  if (reason === SimulatedMsgReason.BABYSIT_PR_IN_CLOUD) return "babysit-pr-in-cloud"
  if (reason === SimulatedMsgReason.MULTITASK_SPLIT_PRS) return "multitask-split-prs"
  if (reason === SimulatedMsgReason.APPLY_LOCALLY) return "apply-locally"
  if (reason === SimulatedMsgReason.CHECKOUT_BRANCH) return "checkout-branch"
  return undefined
}

function projectBranchContext(action: SelectedAgenticGitAction): GitActionBranchContext | undefined {
  const branch = action.branchContext
  if (branch === undefined) return undefined
  return {
    currentBranch: branch.currentBranch || undefined,
    baseBranch: branch.baseBranch || undefined,
    agentBranchPrefix: branch.agentBranchPrefix || undefined,
  }
}

function projectCommitData(params: SelectedAgenticGitActionCommitParams): GitCommitPromptData {
  return {
    filesToCommit: [...params.filesToCommit],
    filesToCommitWithStatus: params.filesToCommitWithStatus.map(file => ({
      path: file.path,
      ...(file.status ? { status: file.status } : {}),
    })),
    filesToExcludeFromCommit: [...params.filesToExcludeFromCommit],
    filesToExcludeFromCommitWithStatus: params.filesToExcludeFromCommitWithStatus.map(file => ({
      path: file.path,
      ...(file.status ? { status: file.status } : {}),
    })),
    shouldStageAllChanges: params.shouldStageAllChanges,
    createPrDraft: params.createPrDraft,
  }
}

function projectSelectedAction(action: SelectedAgenticGitAction): GitActionPromptSelection | undefined {
  const branchContext = projectBranchContext(action)
  switch (action.params.case) {
    case "commitParams":
      return { kind: "commit", params: projectCommitData(action.params.value), branchContext }
    case "commitAndPushParams":
      return { kind: "commit-and-push", params: projectCommitData(action.params.value), branchContext }
    case "createBranchAndCommitParams":
      return { kind: "create-branch-and-commit", params: projectCommitData(action.params.value), branchContext }
    case "createBranchCommitAndPushParams":
      return { kind: "create-branch-commit-and-push", params: projectCommitData(action.params.value), branchContext }
    case "createBranchParams":
      return { kind: "create-branch", branchContext }
    case "createPrWithChangesParams":
      return { kind: "create-pr-with-changes", params: projectCommitData(action.params.value), branchContext }
    case "pushParams":
      return { kind: "push", branchContext }
    case "createPrParams":
      return { kind: "create-pr", draft: action.params.value.createPrDraft, branchContext }
    case "fixMergeConflictsParams":
      return {
        kind: "fix-merge-conflicts",
        baseBranch: action.params.value.baseBranch || undefined,
        prUrl: action.params.value.prUrl || undefined,
        branchContext,
      }
    case "babysitPrInCloudParams":
      return { kind: "babysit-pr", baseBranch: action.params.value.baseBranch || undefined, branchContext }
    case "applyLocallyParams":
      return { kind: "apply-locally", remoteBranch: action.params.value.remoteBranch }
    case "checkoutBranchParams":
      return { kind: "checkout-branch", remoteBranch: action.params.value.remoteBranch }
    case undefined:
      return undefined
  }
}

/** Own prompt contract projected from the selected-context and simulated-reason wire messages. */
export function projectInteropGitActionPrompt(input: InteropGitActionPromptInput): GitActionPromptInput | undefined {
  const reason = projectPromptReason(input.simulatedMsgReason)
  const selectedAction = input.selectedContext.selectedAgenticGitAction
  if (reason === undefined || selectedAction === undefined) return undefined
  const action = projectSelectedAction(selectedAction)
  if (action === undefined) return undefined
  return {
    reason,
    action,
    template: {
      filePath: selectedAction.pathToTemplateFile || undefined,
      directoryPath: selectedAction.pathToTemplateDir || undefined,
    },
    environmentParamForSubagent: input.environmentParamForSubagent,
    babysitV2Prompt: input.babysitV2Prompt,
    enablePrCreationForgeGuidance: input.enablePrCreationForgeGuidance,
  }
}

export function synthesizeInteropGitActionPrompt(input: InteropGitActionPromptInput): string | undefined {
  const projected = projectInteropGitActionPrompt(input)
  return projected === undefined ? undefined : synthesizeGitActionPrompt(projected)
}

export function renderInteropSimulatedMessagePrompts(input: InteropSimulatedPromptInput): SimulatedMessagePromptText[] {
  return renderSimulatedMessagePrompts({
    gitAction: projectInteropGitActionPrompt(input),
    multitaskAction: multitaskActionForReason(input.simulatedMsgReason),
    modelInfo: input.modelInfo,
  })
}

function slateText(value: SlateContextText | undefined): string | undefined {
  if (value === undefined) return undefined
  return value instanceof RedactedString ? value.unwrap(PrivacyCapability.UNSAFE_ALWAYS_ALLOWED) : value
}

function slateGitActionReason(reason: SlateSimulatedReason): GitActionPromptReason | undefined {
  switch (reason) {
    case SlateSimulatedMessageReason.DIFF_TAB_COMMIT: return "diff-tab-commit"
    case SlateSimulatedMessageReason.DIFF_TAB_COMMIT_AND_PUSH: return "diff-tab-commit-and-push"
    case SlateSimulatedMessageReason.DIFF_TAB_PUSH: return "diff-tab-push"
    case SlateSimulatedMessageReason.DIFF_TAB_CREATE_PR: return "diff-tab-create-pr"
    case SlateSimulatedMessageReason.DIFF_TAB_CREATE_BRANCH: return "diff-tab-create-branch"
    case SlateSimulatedMessageReason.DIFF_TAB_FIX_MERGE_CONFLICTS: return "diff-tab-fix-merge-conflicts"
    case SlateSimulatedMessageReason.BABYSIT_PR_IN_CLOUD: return "babysit-pr-in-cloud"
    case SlateSimulatedMessageReason.MULTITASK_SPLIT_PRS: return "multitask-split-prs"
    case SlateSimulatedMessageReason.APPLY_LOCALLY: return "apply-locally"
    case SlateSimulatedMessageReason.CHECKOUT_BRANCH: return "checkout-branch"
    default: return undefined
  }
}

function slateBranchContext(action: SlateRepositoryActionSelection["branch"]): GitActionBranchContext | undefined {
  if (action === undefined) return undefined
  return {
    currentBranch: slateText(action.currentBranch),
    baseBranch: slateText(action.baseBranch),
    agentBranchPrefix: slateText(action.agentBranchPrefix),
  }
}

function slateCommitData(commit: SlateRepositoryCommitIntent): GitCommitPromptData {
  return {
    filesToCommit: commit.files.map(value => slateText(value) ?? ""),
    filesToCommitWithStatus: commit.filesWithStatus.map(file => ({
      path: slateText(file.path) ?? "",
      ...(file.status === undefined ? {} : { status: slateText(file.status) }),
    })),
    filesToExcludeFromCommit: commit.excludedFiles.map(value => slateText(value) ?? ""),
    filesToExcludeFromCommitWithStatus: commit.excludedFilesWithStatus.map(file => ({
      path: slateText(file.path) ?? "",
      ...(file.status === undefined ? {} : { status: slateText(file.status) }),
    })),
    shouldStageAllChanges: commit.stageAllChanges,
    createPrDraft: commit.draftPullRequest,
  }
}

function slateActionSelection(action: SlateRepositoryActionSelection): GitActionPromptSelection | undefined {
  const parameters = action.parameters
  if (parameters === undefined) return undefined
  const branchContext = slateBranchContext(action.branch)
  switch (parameters.kind) {
    case "commit": return { kind: "commit", params: slateCommitData(parameters.commit), branchContext }
    case "commit-and-push": return { kind: "commit-and-push", params: slateCommitData(parameters.commit), branchContext }
    case "create-branch-and-commit": return { kind: "create-branch-and-commit", params: slateCommitData(parameters.commit), branchContext }
    case "create-branch-commit-and-push": return { kind: "create-branch-commit-and-push", params: slateCommitData(parameters.commit), branchContext }
    case "create-branch": return { kind: "create-branch", branchContext }
    case "create-pull-request-with-changes": return { kind: "create-pr-with-changes", params: slateCommitData(parameters.commit), branchContext }
    case "push": return { kind: "push", branchContext }
    case "create-pull-request": return { kind: "create-pr", draft: parameters.draft, branchContext }
    case "fix-merge-conflicts": return {
      kind: "fix-merge-conflicts",
      baseBranch: slateText(parameters.baseBranch),
      prUrl: slateText(parameters.pullRequestUrl),
      branchContext,
    }
    case "babysit-pull-request": return { kind: "babysit-pr", baseBranch: slateText(parameters.baseBranch), branchContext }
    case "apply-locally": return { kind: "apply-locally", remoteBranch: slateText(parameters.remoteBranch) ?? "" }
    case "checkout-branch": return { kind: "checkout-branch", remoteBranch: slateText(parameters.remoteBranch) ?? "" }
    case "update-branch": return undefined
  }
}

/** Prompt view projected directly from the Slate-owned selected-context state. */
export function renderSlateSelectedContextSimulatedMessagePrompts(input: {
  readonly action?: SlateRepositoryActionSelection
  readonly reason: SlateSimulatedReason | undefined
  readonly modelInfo?: TaskToolModelInfo | undefined
  readonly environmentParamForSubagent?: boolean | undefined
  readonly babysitV2Prompt?: boolean | undefined
  readonly enablePrCreationForgeGuidance?: boolean | undefined
}): SimulatedMessagePromptText[] {
  const reason = input.reason
  const promptReason = reason === undefined ? undefined : slateGitActionReason(reason)
  const action = input.action === undefined ? undefined : slateActionSelection(input.action)
  const gitAction = promptReason === undefined
    ? undefined
    : {
        reason: promptReason,
        ...(action === undefined ? {} : { action }),
        template: {
          filePath: slateText(input.action?.templateFilePath),
          directoryPath: slateText(input.action?.templateDirectoryPath),
        },
        environmentParamForSubagent: input.environmentParamForSubagent,
        babysitV2Prompt: input.babysitV2Prompt,
        enablePrCreationForgeGuidance: input.enablePrCreationForgeGuidance,
      }
  const interopReason = reason === undefined
    ? SimulatedMsgReason.UNSPECIFIED
    : toInteropSimulatedMessageReason(reason)
  return renderSimulatedMessagePrompts({
    gitAction,
    multitaskAction: multitaskActionForReason(interopReason),
    modelInfo: input.modelInfo,
  })
}
