function summaryHeader(): string {
  return "\n\nThe following files were also edited, but their diff has been excluded for brevity:\n\n"
}

function moreFilesLine(count: number): string {
  return `\n- ${count} more filenames (paths not included for brevity)`
}

/** Describe every file that has no body in the selected diff, within the text budget left for that description. */
export function summarizeExcludedDiffFiles(
  originalNames: readonly string[],
  selectedNames: readonly string[],
  characterLimit?: number,
): string {
  const selected = new Set(selectedNames)
  const omitted = originalNames.filter((name) => !selected.has(name))
  if (omitted.length === 0) return ""

  const header = summaryHeader()
  if (characterLimit === undefined) return header + omitted.map((name) => `- ${name}`).join("\n")

  const included: string[] = []
  let used = header.length
  for (const name of omitted) {
    const line = `- ${name}\n`
    const remainder = omitted.length - included.length - 1
    const tailSize = remainder > 0 ? moreFilesLine(remainder).length : 0
    if (used + line.length + tailSize > characterLimit) break
    included.push(name)
    used += line.length
  }

  const unlisted = omitted.length - included.length
  if (included.length === 0) {
    return unlisted > 0
      ? `${header}- ${unlisted} files (paths not included for brevity)`
      : ""
  }
  return header + included.map((name) => `- ${name}`).join("\n") + (unlisted > 0 ? moreFilesLine(unlisted) : "")
}
