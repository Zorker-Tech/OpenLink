import type { SelectedCodeSelectionForPrompt } from "./code-selection-context-contracts.ts"
import type { SelectedTerminalForPrompt, SelectedTerminalSelectionForPrompt } from "./terminal-context-contracts.ts"
import type { SlateDirectoryTreeNode } from "../tools/core/ls/directory-tree-contracts.ts"

export interface SlateSelectedFile {
  readonly path: string
  readonly content: string
  readonly relativePath?: string
}

export interface SlateSelectedFolder {
  readonly path: string
  readonly relativePath?: string
  readonly directoryTree?: SlateDirectoryTreeNode
}

/** Workspace material the user attached to a turn, grouped by how the prompt pipeline consumes it. */
export interface SlateWorkspaceSelectionContext {
  readonly files: readonly SlateSelectedFile[]
  readonly codeSelections: readonly SelectedCodeSelectionForPrompt[]
  readonly terminals: readonly SelectedTerminalForPrompt[]
  readonly terminalSelections: readonly SelectedTerminalSelectionForPrompt[]
  readonly folders: readonly SlateSelectedFolder[]
}
