import type { ParsedDiffBlocks, ParsedDiffFileBlock } from "./git-diff-attachment-contracts.ts"

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+?)$/gm

interface FileStart {
  readonly offset: number
  readonly sourcePath: string
  readonly targetPath: string
}

function readFileStarts(diffText: string): FileStart[] {
  return Array.from(diffText.matchAll(FILE_HEADER), (match) => ({
    offset: match.index ?? 0,
    sourcePath: match[1]?.trim() ?? "",
    targetPath: match[2]?.trim() ?? "",
  }))
}

function makeFileBlocks(diffText: string, starts: readonly FileStart[]): ParsedDiffFileBlock[] {
  return starts.map((start, position) => {
    const next = starts[position + 1]
    return {
      fileName: start.targetPath || start.sourcePath || "unknown file",
      content: diffText.slice(start.offset, next?.offset ?? diffText.length),
    }
  })
}

/** Separates the introductory text from each per-path block, retaining original order and bytes. */
export function splitDiffAtPathBoundaries(diffText: string): ParsedDiffBlocks {
  const starts = readFileStarts(diffText)
  const first = starts[0]
  if (first === undefined) return { preface: diffText, files: [] }

  return {
    preface: diffText.slice(0, first.offset),
    files: makeFileBlocks(diffText, starts),
  }
}
