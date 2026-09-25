/**
 * A directory tree written out for the model, within a budget.
 *
 * A listing is useful until it is a dump of a monorepo, so the tree is rendered at three levels of
 * detail: the whole tree, the tree with directories collapsed to a count of their contents, and the tree
 * with the depth limited. The first rendering that fits the budget is used, which means the detail is
 * given up only as far as it has to be.
 *
 * Where a directory is collapsed, what is shown is the shape of its subtree — how many files and which
 * extensions dominate — because that is what tells a reader whether to look inside. The separator is
 * taken from the root's own path, so a Windows tree reads as a Windows tree.
 */

import path from "node:path"

import type { LsDirectoryTreeNode } from "../../../../proto/generated/agent/v1/ls_exec_pb.ts"

const LS_CHARACTER_BUDGET = 10_000

interface DirectoryTreeRenderResult {
  readonly result: string
  readonly atLeastOneExtensionCountRendered: boolean
}

export function renderDirectoryTreeWithinBudget(
  rootDirectory: LsDirectoryTreeNode,
  characterBudget?: number,
): DirectoryTreeRenderResult {
  const budget = characterBudget ?? LS_CHARACTER_BUDGET
  let renderResult = renderDirectoryTree(rootDirectory)
  if (renderResult.result.length > budget) {
    renderResult = renderDirectoryTree(rootDirectory, true, 0)
    if (renderResult.result.length > budget) {
      renderResult = renderDirectoryTree(rootDirectory, false, 0)
    }
  }
  return renderResult
}

function renderDirectoryTree(
  rootDirectory: LsDirectoryTreeNode,
  renderExtensionCounts = true,
  renderDepthLimit?: number,
): DirectoryTreeRenderResult {
  let atLeastOneExtensionCountRendered = false
  const pathSep = rootDirectory.absPath.includes("\\") ? "\\" : "/"
  function render(dir: LsDirectoryTreeNode, depth: number): string {
    const indent = "  ".repeat(depth)
    let result: string
    if (depth === 0) {
      const trailingSep = dir.absPath.endsWith(pathSep) ? "" : pathSep
      result = `${dir.absPath}${trailingSep}\n`
    } else {
      const normalizedPath = dir.absPath.replaceAll(path.win32.sep, path.posix.sep)
      result = `${indent}- ${path.posix.basename(normalizedPath)}${pathSep}\n`
    }
    // Files and directories are interleaved by name, which is how a reader expects a tree to read.
    const allChildren = [
      ...dir.childrenFiles.map(file => ({
        type: "file" as const,
        name: file.name,
        terminalMetadata: file.terminalMetadata,
      })),
      ...dir.childrenDirs.map(childDir => ({
        type: "dir" as const,
        name: path.posix.basename(childDir.absPath.replaceAll(path.win32.sep, path.posix.sep)),
        dir: childDir,
      })),
    ]
    allChildren.sort((a, b) => a.name.localeCompare(b.name))
    const childIndent = "  ".repeat(depth + 1)
    for (const child of allChildren) {
      if (child.type === "file") {
        result += `${childIndent}- ${child.name}\n`
        if (child.terminalMetadata) result += renderTerminalMetadata(child.terminalMetadata, `${childIndent}  `)
      } else {
        const childDir = child.dir
        if (childDir.childrenWereProcessed && (renderDepthLimit === undefined || depth < renderDepthLimit)) {
          result += render(childDir, depth + 1)
        } else {
          const extensionCounts = Object.entries(childDir.fullSubtreeExtensionCounts)
          if (extensionCounts.length > 0 && renderExtensionCounts) {
            const numTopExtensions = 3
            let sortedExtensions = extensionCounts
              .sort(([extensionA, countA], [extensionB, countB]) => {
                if (countB !== countA) return countB - countA
                return extensionA.localeCompare(extensionB)
              })
              .slice(0, numTopExtensions)
              .map(([extension, count]) => `${count} *${extension || "no-ext"}`)
              .join(", ")
            if (extensionCounts.length > numTopExtensions) sortedExtensions += ", ..."
            const numFiles = childDir.numFiles
            result += `${childIndent}- ${child.name}${pathSep}\n`
            result += `${childIndent}  [${numFiles} file${numFiles === 1 ? "" : "s"} in subtree: ${sortedExtensions}]\n`
            atLeastOneExtensionCountRendered = true
          } else {
            result += `${childIndent}- ${child.name}${pathSep}...\n`
          }
        }
      }
    }
    return result
  }
  const result = render(rootDirectory, 0)
  return { result, atLeastOneExtensionCountRendered }
}

/** What the platform knows about a file that is really a terminal session's history. */
function renderTerminalMetadata(metadata: {
  readonly cwd?: string | undefined
  readonly lastModifiedMs?: bigint | undefined
  readonly lastCommands?: readonly TerminalCommandLike[] | undefined
  readonly currentCommand?: TerminalCommandLike | undefined
}, metadataIndent: string): string {
  const time = (milliseconds: bigint): string => new Date(Number(milliseconds)).toISOString()
  const ifDefined = <T>(value: T | undefined, format: (present: T) => string): string | undefined =>
    value !== undefined ? format(value) : undefined
  const formatCommand = (command: TerminalCommandLike): string => [
    command.command,
    ifDefined(command.exitCode, value => `exit: ${value}`),
    ifDefined(command.timestampMs, value => `time: ${time(value)}`),
    ifDefined(command.durationMs, value => `duration: ${value}ms`),
  ].filter(Boolean).join(", ")
  let result = ""
  if (metadata.cwd) result += `${metadataIndent}cwd: ${metadata.cwd}\n`
  if (metadata.lastModifiedMs) result += `${metadataIndent}last modified: ${time(metadata.lastModifiedMs)}\n`
  if (metadata.lastCommands && metadata.lastCommands.length > 0) {
    result += `${metadataIndent}last commands:\n`
    for (const command of metadata.lastCommands) result += `${metadataIndent}  - ${formatCommand(command)}\n`
  }
  if (metadata.currentCommand) {
    result += `${metadataIndent}current command:\n`
    result += `${metadataIndent}  - ${formatCommand(metadata.currentCommand)}\n`
  }
  return result
}

interface TerminalCommandLike {
  readonly command: string
  readonly exitCode?: number | undefined
  readonly timestampMs?: bigint | undefined
  readonly durationMs?: bigint | undefined
}
