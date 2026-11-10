import { renderDirectoryTree } from "./directory-tree-renderer.ts"
import type { DirectoryTreeRenderResult, SlateDirectoryTreeNode } from "./directory-tree-contracts.ts"

const DEFAULT_TREE_BUDGET = 10_000

const PRESENTATION_LEVELS = [
  { showExtensionCounts: true, maximumDepth: undefined },
  { showExtensionCounts: true, maximumDepth: 0 },
  { showExtensionCounts: false, maximumDepth: 0 },
] as const

export function renderDirectoryTreeWithinBudget(
  rootDirectory: SlateDirectoryTreeNode,
  characterBudget = DEFAULT_TREE_BUDGET,
): DirectoryTreeRenderResult {
  let leastDetailed: DirectoryTreeRenderResult | undefined
  for (const presentation of PRESENTATION_LEVELS) {
    const rendered = renderDirectoryTree(rootDirectory, presentation)
    leastDetailed = rendered
    if (rendered.result.length <= characterBudget) return rendered
  }
  return leastDetailed!
}

export type { DirectoryTreeRenderResult, SlateDirectoryTreeFile, SlateDirectoryTreeNode, SlateTerminalCommand, SlateTerminalMetadata } from "./directory-tree-contracts.ts"
