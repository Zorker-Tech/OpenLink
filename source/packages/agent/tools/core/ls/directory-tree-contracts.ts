import type {
  SlateDirectoryTreeFile,
  SlateDirectoryTreeNode,
  SlateTerminalCommand,
  SlateTerminalMetadata,
} from "../../../../agent-exec/ls.ts"

export type {
  SlateDirectoryTreeFile,
  SlateDirectoryTreeNode,
  SlateTerminalCommand,
  SlateTerminalMetadata,
} from "../../../../agent-exec/ls.ts"

export interface DirectoryTreeRenderResult {
  readonly result: string
  readonly atLeastOneExtensionCountRendered: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
}

function isTerminalCommand(value: unknown): value is SlateTerminalCommand {
  if (!isRecord(value) || typeof value.command !== "string") return false
  return (value.exitCode === undefined || isInt32(value.exitCode)) &&
    (value.timestampMs === undefined || typeof value.timestampMs === "bigint") &&
    (value.durationMs === undefined || typeof value.durationMs === "bigint")
}

function isTerminalMetadata(value: unknown): value is SlateTerminalMetadata {
  if (!isRecord(value)) return false
  return (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.lastModifiedMs === undefined || typeof value.lastModifiedMs === "bigint") &&
    (value.lastCommands === undefined || Array.isArray(value.lastCommands) && value.lastCommands.every(isTerminalCommand)) &&
    (value.currentCommand === undefined || isTerminalCommand(value.currentCommand))
}

/** Runtime guard for data crossing storage or other dynamic boundaries into the directory renderer. */
export function isSlateDirectoryTreeNode(value: unknown): value is SlateDirectoryTreeNode {
  return isSlateDirectoryTreeNodeWithin(value, new Set())
}

function isSlateDirectoryTreeNodeWithin(value: unknown, ancestors: Set<object>): value is SlateDirectoryTreeNode {
  if (!isRecord(value) || ancestors.has(value)) return false
  if (typeof value.absPath !== "string" || typeof value.childrenWereProcessed !== "boolean" ||
      !isInt32(value.numFiles) || !Array.isArray(value.childrenFiles) || !Array.isArray(value.childrenDirs) ||
      !isRecord(value.fullSubtreeExtensionCounts) ||
      !Object.values(value.fullSubtreeExtensionCounts).every(isInt32)) return false
  if (!value.childrenFiles.every(file => isRecord(file) && typeof file.name === "string" &&
      (file.terminalMetadata === undefined || isTerminalMetadata(file.terminalMetadata)))) return false
  ancestors.add(value)
  const childrenAreValid = value.childrenDirs.every(child => isSlateDirectoryTreeNodeWithin(child, ancestors))
  ancestors.delete(value)
  return childrenAreValid
}
