import path from "node:path"
import type { SlateDirectoryTreeFile, SlateDirectoryTreeNode } from "./directory-tree-contracts.ts"
import { formatTerminalMetadata } from "./directory-tree-terminal-metadata.ts"

interface DirectoryTreeRenderOptions {
  readonly showExtensionCounts: boolean
  readonly maximumDepth?: number | undefined
}

type Child =
  | { readonly kind: "file"; readonly name: string; readonly file: SlateDirectoryTreeFile }
  | { readonly kind: "directory"; readonly name: string; readonly directory: SlateDirectoryTreeNode }

function posixName(value: string): string {
  return path.posix.basename(value.replaceAll(path.win32.sep, path.posix.sep))
}

function childrenOf(directory: SlateDirectoryTreeNode): Child[] {
  return [
    ...directory.childrenFiles.map((file): Child => ({ kind: "file", name: file.name, file })),
    ...directory.childrenDirs.map((child): Child => ({ kind: "directory", name: posixName(child.absPath), directory: child })),
  ].sort((left, right) => left.name.localeCompare(right.name))
}

function extensionSummary(directory: SlateDirectoryTreeNode): string {
  const all = Object.entries(directory.fullSubtreeExtensionCounts)
  const leading = all
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, 3)
    .map(([extension, count]) => `${count} *${extension || "no-ext"}`)
  if (all.length > 3) leading.push("...")
  return leading.join(", ")
}

export function renderDirectoryTree(
  root: SlateDirectoryTreeNode,
  options: DirectoryTreeRenderOptions,
): { readonly result: string; readonly atLeastOneExtensionCountRendered: boolean } {
  const separator = root.absPath.includes("\\") ? "\\" : "/"
  const lines: string[] = []
  let renderedExtensionSummary = false

  const visit = (directory: SlateDirectoryTreeNode, depth: number): void => {
    const indent = "  ".repeat(depth)
    if (depth === 0) {
      const trailingSlash = directory.absPath.endsWith(separator) ? "" : separator
      lines.push(`${directory.absPath}${trailingSlash}\n`)
    } else {
      lines.push(`${indent}- ${posixName(directory.absPath)}${separator}\n`)
    }

    const childIndent = "  ".repeat(depth + 1)
    for (const child of childrenOf(directory)) {
      if (child.kind === "file") {
        lines.push(`${childIndent}- ${child.name}\n`)
        if (child.file.terminalMetadata !== undefined) {
          lines.push(formatTerminalMetadata(child.file.terminalMetadata, `${childIndent}  `))
        }
        continue
      }

      const childDirectory = child.directory
      const depthAllowsWalk = options.maximumDepth === undefined || depth < options.maximumDepth
      if (childDirectory.childrenWereProcessed && depthAllowsWalk) {
        visit(childDirectory, depth + 1)
        continue
      }
      const extensionCount = Object.keys(childDirectory.fullSubtreeExtensionCounts).length
      if (options.showExtensionCounts && extensionCount > 0) {
        lines.push(`${childIndent}- ${child.name}${separator}\n`)
        const count = childDirectory.numFiles
        const noun = count === 1 ? "file" : "files"
        lines.push(`${childIndent}  [${count} ${noun} in subtree: ${extensionSummary(childDirectory)}]\n`)
        renderedExtensionSummary = true
      } else {
        lines.push(`${childIndent}- ${child.name}${separator}...\n`)
      }
    }
  }

  visit(root, 0)
  return { result: lines.join(""), atLeastOneExtensionCountRendered: renderedExtensionSummary }
}
