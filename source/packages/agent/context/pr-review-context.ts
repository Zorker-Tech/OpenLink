export interface PrReviewInput {
  readonly filePath: string
  readonly startLine: number
  readonly endLine: number
  readonly prUrl: string
  readonly diffContent?: string | undefined
}

export interface PrReviewTextContent {
  readonly type: "text"
  readonly text: string
}

function locationLabel(selection: PrReviewInput): string {
  return selection.startLine === selection.endLine
    ? `line ${selection.startLine}`
    : `lines ${selection.startLine}-${selection.endLine}`
}

function diffSection(content: string | undefined): string[] {
  return content ? ["Diff Content:", content] : []
}

function renderSelection(selection: PrReviewInput): string {
  return [
    "<pr_review_content>",
    `File: ${selection.filePath}`,
    `Location: ${locationLabel(selection)}`,
    `PR URL: ${selection.prUrl}`,
    ...diffSection(selection.diffContent),
    "</pr_review_content>",
  ].join("\n")
}

export function renderPrReviewContext(
  selections: readonly PrReviewInput[],
): PrReviewTextContent | undefined {
  if (selections.length === 0) return undefined

  const renderedSelections = selections.map(renderSelection).join("\n\n")
  return {
    type: "text",
    text: `<pr_review_context>\nReview selections from a pull request are listed below.\n${renderedSelections}\n</pr_review_context>`,
  }
}
