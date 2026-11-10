import {
  DEFAULT_DIFF_TRUNCATION_NOTICE,
  DIFF_NO_BUDGET_MESSAGE,
  type DiffTruncationOptions,
  type ParsedDiff,
  type ParsedDiffFile,
} from "./diff-processing-contracts.ts"
import { summarizeExcludedDiffFiles } from "./diff-processing-summary.ts"
import { clipDiffWithNotice } from "./diff-processing-truncation.ts"

function preferSmallChanges(files: readonly ParsedDiffFile[], skipSorting: boolean): ParsedDiffFile[] {
  return skipSorting ? [...files] : [...files].sort((left, right) => left.content.length - right.content.length)
}

function prefixCharacterCounts(files: readonly ParsedDiffFile[]): number[] {
  const totals = [0]
  for (const file of files) totals.push(totals.at(-1)! + file.content.length)
  return totals
}

function largestIncludedPrefix(args: {
  files: readonly ParsedDiffFile[]
  prefixTotals: readonly number[]
  originalNames: readonly string[]
  prefaceLength: number
  maximumCharacters: number
}): number {
  let lower = 0
  let upper = args.files.length
  let largest = 0
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2)
    const includedNames = args.files.slice(0, count).map(({ fileName }) => fileName)
    const omissionSummary = summarizeExcludedDiffFiles(args.originalNames, includedNames)
    const projectedSize = args.prefaceLength + args.prefixTotals[count]! + omissionSummary.length
    if (projectedSize <= args.maximumCharacters) {
      largest = count
      lower = count + 1
    } else {
      upper = count - 1
    }
  }
  return largest
}

function renderBudgetedDiff(args: {
  preface: string
  allNames: readonly string[]
  includedFiles: readonly ParsedDiffFile[]
  summaryLimit?: number
}): string {
  const selectedNames = args.includedFiles.map(({ fileName }) => fileName)
  const summary = summarizeExcludedDiffFiles(args.allNames, selectedNames, args.summaryLimit)
  return args.preface + args.includedFiles.map(({ content }) => content).join("") + summary
}

export function formatParsedDiffWithTruncation(
  parsed: ParsedDiff,
  maximumCharacters: number,
  options: DiffTruncationOptions = {},
): string {
  const notice = options.truncationNotice ?? DEFAULT_DIFF_TRUNCATION_NOTICE
  if (maximumCharacters <= 0) return DIFF_NO_BUDGET_MESSAGE

  if (parsed.files.length === 0) {
    const original = options.originalContent ?? parsed.preface
    return original.length <= maximumCharacters
      ? original
      : clipDiffWithNotice(original, maximumCharacters, notice)
  }

  const candidates = preferSmallChanges(parsed.files, options.skipSorting === true)
  const namesInInputOrder = parsed.files.map(({ fileName }) => fileName)
  const characterTotals = prefixCharacterCounts(candidates)
  const keepCount = largestIncludedPrefix({
    files: candidates,
    prefixTotals: characterTotals,
    originalNames: namesInInputOrder,
    prefaceLength: parsed.preface.length,
    maximumCharacters,
  })
  const includedFiles = candidates.slice(0, keepCount)

  let formatted = renderBudgetedDiff({
    preface: parsed.preface,
    allNames: namesInInputOrder,
    includedFiles,
  })
  if (formatted.length > maximumCharacters) {
    formatted = renderBudgetedDiff({
      preface: parsed.preface,
      allNames: namesInInputOrder,
      includedFiles,
      summaryLimit: Math.max(0, maximumCharacters - parsed.preface.length),
    })
  }
  if (formatted.length <= maximumCharacters) return formatted

  return clipDiffWithNotice(options.originalContent ?? formatted, maximumCharacters, notice)
}
