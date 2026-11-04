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
