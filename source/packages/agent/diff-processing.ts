/**
 * Fitting a diff into a budget without hiding which files were left out.
 *
 * A diff is the most useful thing an attached change carries and the easiest thing to make too large, so
 * it is cut down rather than dropped: files are taken smallest first — the small ones are usually the
 * ones that explain the change — and whatever does not fit is named in a summary, because a reader who
 * cannot see a file's diff still needs to know the file was touched. The count that fits is found by
 * bisection rather than by adding files one at a time, since the summary's own length changes as files
 * are added to it.
 *
 * When even the summary does not fit, the content is cut with a notice; and when there is no budget at
 * all, the diff is replaced by a line saying so rather than by an empty string, because "nothing" and
 * "omitted" are different things to a reader.
 */

const DIFF_TRUNCATION_NOTICE = "\n\n[diff truncated due to size]"
export const DIFF_NO_BUDGET_MESSAGE = "[diff omitted due to size constraints]"

interface ParsedDiffFile {
  readonly fileName: string
  readonly content: string
}

interface ParsedDiff {
  readonly preface: string
  readonly files: readonly ParsedDiffFile[]
}

interface DiffTruncationOptions {
  readonly originalContent?: string
  readonly truncationNotice?: string
  readonly skipSorting?: boolean
}

export function formatParsedDiffWithTruncation(
  parsedDiff: ParsedDiff,
  maxCharLength: number,
  options: DiffTruncationOptions = {},
): string {
  const { originalContent, truncationNotice = DIFF_TRUNCATION_NOTICE, skipSorting = false } = options
  if (maxCharLength <= 0) return DIFF_NO_BUDGET_MESSAGE
  if (parsedDiff.files.length === 0) {
    const content = originalContent ?? parsedDiff.preface
    if (content.length <= maxCharLength) return content
    return truncateWithNotice(content, maxCharLength, truncationNotice)
  }
  const filesToProcess = skipSorting
    ? parsedDiff.files
    : [...parsedDiff.files].sort((a, b) => a.content.length - b.content.length)
  const allFilenames = parsedDiff.files.map(file => file.fileName)
  const includedFilenames = filesToProcess.map(file => file.fileName)
  const includedContents = filesToProcess.map(file => file.content)
  const prefaceLength = parsedDiff.preface.length
  let totalContentLength = includedContents.reduce((sum, content) => sum + content.length, 0)
  const buildDiffString = (maxCharsForSummary?: number): string => {
    const summary = buildTruncatedFilenameSummary(allFilenames, includedFilenames, maxCharsForSummary)
    return parsedDiff.preface + includedContents.join("") + summary
  }
  let left = 0
  let right = includedContents.length
  let bestCount = 0
  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    const testTotalContentLength = includedContents.slice(0, mid).reduce((sum, content) => sum + content.length, 0)
    const testSummary = buildTruncatedFilenameSummary(allFilenames, includedFilenames.slice(0, mid))
    if (prefaceLength + testTotalContentLength + testSummary.length <= maxCharLength) {
      bestCount = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }
  includedContents.splice(bestCount)
  includedFilenames.splice(bestCount)
  totalContentLength = includedContents.reduce((sum, content) => sum + content.length, 0)
  let diffString = buildDiffString()
  // The summary grows as files are named, so a second pass with what is left may be needed.
  if (diffString.length > maxCharLength) {
    diffString = buildDiffString(Math.max(0, maxCharLength - parsedDiff.preface.length))
  }
  if (diffString.length > maxCharLength) {
    return truncateWithNotice(originalContent ?? diffString, maxCharLength, truncationNotice)
  }
  return diffString
}

function buildTruncatedFilenameSummary(
  allFilenames: readonly string[],
  includedFilenames: readonly string[],
  maxChars?: number,
): string {
  const includedSet = new Set(includedFilenames)
  const excludedFilenames = allFilenames.filter(filename => !includedSet.has(filename))
  if (excludedFilenames.length === 0) return ""
  const header = "\n\nThe following files were also edited, but their diff has been excluded for brevity:\n\n"
  const filenameLineLength = (filename: string): number => `- ${filename}\n`.length
  const summaryLineLength = (remainingCount: number): number =>
    `\n- ${remainingCount} more filenames (paths not included for brevity)`.length
  if (maxChars === undefined) {
    return header + excludedFilenames.map(filename => `- ${filename}`).join("\n")
  }
  let currentLength = header.length
  const filesThatFit: string[] = []
  for (const filename of excludedFilenames) {
    const remainingCount = excludedFilenames.length - filesThatFit.length - 1
    const summaryLength = remainingCount > 0 ? summaryLineLength(remainingCount) : 0
    if (currentLength + filenameLineLength(filename) + summaryLength <= maxChars) {
      filesThatFit.push(filename)
      currentLength += filenameLineLength(filename)
    } else {
      break
    }
  }
  const remainingCount = excludedFilenames.length - filesThatFit.length
  if (filesThatFit.length === 0) {
    return remainingCount > 0 ? `${header}- ${remainingCount} files (paths not included for brevity)` : ""
  }
  let result = header + filesThatFit.map(filename => `- ${filename}`).join("\n")
  if (remainingCount > 0) result += `\n- ${remainingCount} more filenames (paths not included for brevity)`
  return result
}

function truncateWithNotice(
  diffContent: string,
  maxCharLength: number,
  truncationNotice = DIFF_TRUNCATION_NOTICE,
): string {
  if (maxCharLength < DIFF_NO_BUDGET_MESSAGE.length) return ""
  if (maxCharLength < truncationNotice.length) return DIFF_NO_BUDGET_MESSAGE
  const visibleLength = maxCharLength - truncationNotice.length
  if (visibleLength <= 0) return DIFF_NO_BUDGET_MESSAGE
  return diffContent.slice(0, visibleLength) + truncationNotice
}
