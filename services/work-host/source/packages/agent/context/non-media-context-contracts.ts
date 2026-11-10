import type { AttachedGitCommit } from "../git-commit-processing.ts";
import type { SelectedGitDiffAttachment } from "../git-diff-attachment-contracts.ts";
import type { AttachedCommandForPrompt } from "./attached-commands-context.ts";

/** Slate-owned fields needed to assemble the non-media part of a turn. */
export interface NonMediaSelectedContext {
  readonly attachedCommands: readonly AttachedCommandForPrompt[];
  readonly gitDiff?: SelectedGitDiffAttachment | undefined;
  readonly gitDiffFromBranchToMain?: SelectedGitDiffAttachment | undefined;
  readonly gitCommits: readonly AttachedGitCommit[];
}
