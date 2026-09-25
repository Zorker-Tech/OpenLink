/**
 * The diff a file edit produced, in the form git would print it.
 *
 * A written file has to be reported as a change rather than as a new file's contents, and the report has
 * to look like what the user expects from git: a header naming both sides, hunks with their line ranges,
 * and the counts of added and removed lines. An added file and a deleted one are named as `/dev/null` on
 * the side that does not exist, which is how git names it and what the review tooling reads.
 *
 * The text is normalized to end in a newline before diffing, so a file that lacks the trailing newline
 * does not produce a spurious final change.
 */

import { structuredPatch } from "diff"

export interface DiffWorkerInput {
  readonly original: string
  readonly new: string
  readonly filePath?: string
  readonly fileChangeType?: string
}

export interface DiffWorkerResult {
  readonly diffString: string
  readonly linesAdded: number
  readonly linesRemoved: number
}

function withGitDiffPrefix(path: string, prefix: string): string {
  if (path === "/dev/null") return path
  return `${prefix}/${path}`
}

export function calculateDiff(params: DiffWorkerInput): DiffWorkerResult {
  const ensureNL = (value: string): string => (value === "" || value.endsWith("\n") ? value : `${value}\n`)
  const { hunks } = structuredPatch("a", "b", ensureNL(params.original), ensureNL(params.new), "", "", { context: 3 })
  const formatRange = (start: number, lineCount: number): string => {
    if (lineCount === 0) return `${start},0`
    if (lineCount === 1) return `${start}`
    return `${start},${lineCount}`
  }
  const trimmedFilePath = params.filePath?.trim()
  const normalizedFilePath = trimmedFilePath && trimmedFilePath.length > 0 ? trimmedFilePath : "file"
  const fileChangeType = params.fileChangeType ?? "modified"
  const oldPath = fileChangeType === "added" ? "/dev/null" : normalizedFilePath
  const newPath = fileChangeType === "deleted" ? "/dev/null" : normalizedFilePath
  const diffString = hunks.length === 0
    ? ""
    : [
      `--- ${withGitDiffPrefix(oldPath, "a")}`,
      `+++ ${withGitDiffPrefix(newPath, "b")}`,
      ...hunks.flatMap(hunk => [
        `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`,
        ...hunk.lines,
      ]),
    ].join("\n")
  return {
    diffString,
    linesAdded: hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("+")).length, 0),
    linesRemoved: hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith("-")).length, 0),
  }
}

export default calculateDiff
