import type { SelectedContext } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { NonMediaSelectedContext } from "../../../packages/agent/context/non-media-context-contracts.ts";
import { toAttachedGitCommits } from "./selected-git-commits-adapter.ts";

/** Projects the generated selection message into the fields Slate's text assembler understands. */
export function projectSelectedNonMediaContext(selected: SelectedContext): NonMediaSelectedContext {
  return {
    attachedCommands: selected.cursorCommands.map(command => ({
      name: command.name,
      content: command.content,
      ...(command.fullPath === undefined ? {} : { sourcePath: command.fullPath }),
    })),
    gitDiff: selected.gitDiff === undefined
      ? undefined
      : {
        content: selected.gitDiff.content,
        fullContentLengthCharCount: selected.gitDiff.fullContentLengthCharCount,
      },
    gitDiffFromBranchToMain: selected.gitDiffFromBranchToMain === undefined
      ? undefined
      : {
        content: selected.gitDiffFromBranchToMain.content,
        fullContentLengthCharCount: selected.gitDiffFromBranchToMain.fullContentLengthCharCount,
      },
    gitCommits: toAttachedGitCommits(selected.gitCommits),
  };
}
