/**
 * The pull request diff lines the user attached.
 *
 * A review comment is about a place in a file, so each attachment is rendered with its file, its line
 * range and the pull request it belongs to — and with the diff itself when the platform was able to fetch
 * it. A range of one line is written as one line rather than as a range that happens to be empty.
 */

import type { SelectedGitPRDiffSelection } from "../../proto/generated/agent/v1/selected_context_pb.ts"

export interface PrReviewTextContent {
  readonly type: "text"
  readonly text: string
}

export function renderPrReviewContext(
  hydratedGitPrDiffSelections: readonly SelectedGitPRDiffSelection[],
): PrReviewTextContent | undefined {
  if (hydratedGitPrDiffSelections.length === 0) return undefined
  const prDiffText = hydratedGitPrDiffSelections.map(selection => {
    const lineRange = selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`
    let text = `<pr_review_content>
File: ${selection.filePath}
Location: ${lineRange}
PR URL: ${selection.prUrl}`
    if (selection.diffContent) {
      text += `
Diff Content:
${selection.diffContent}`
    }
    text += `
</pr_review_content>`
    return text
  }).join("\n\n")
  return {
    type: "text",
    text: `<pr_review_context>
The user has attached diffs from a pull request
${prDiffText}
</pr_review_context>`,
  }
}
