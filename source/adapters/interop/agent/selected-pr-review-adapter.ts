import type { SelectedGitPRDiffSelection } from "../proto/generated/agent/v1/selected_context_pb.ts";
import type { PrReviewInput } from "../../../packages/agent/context/pr-review-context.ts";

export function toPrReviewInputs(
  selections: readonly SelectedGitPRDiffSelection[],
): PrReviewInput[] {
  return selections.map(selection => ({
    filePath: selection.filePath,
    startLine: selection.startLine,
    endLine: selection.endLine,
    prUrl: selection.prUrl,
    ...(selection.diffContent === undefined ? {} : { diffContent: selection.diffContent }),
  }));
}
