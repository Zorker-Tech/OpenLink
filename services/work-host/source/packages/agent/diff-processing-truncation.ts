import { DIFF_NO_BUDGET_MESSAGE } from "./diff-processing-contracts.ts"

export function clipDiffWithNotice(
  content: string,
  maximumCharacters: number,
  notice: string,
): string {
  if (maximumCharacters < DIFF_NO_BUDGET_MESSAGE.length) return ""
  if (maximumCharacters < notice.length) return DIFF_NO_BUDGET_MESSAGE
  const available = maximumCharacters - notice.length
  if (available <= 0) return DIFF_NO_BUDGET_MESSAGE
  return content.slice(0, available) + notice
}
