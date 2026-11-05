import type {
  LsDirectoryTreeNode,
  LsDirectoryTreeNode_File,
  TerminalMetadata,
  TerminalMetadata_Command,
} from "../proto/generated/agent/v1/ls_exec_pb.ts"
import type {
  SlateDirectoryTreeFile,
  SlateDirectoryTreeNode,
  SlateTerminalCommand,
  SlateTerminalMetadata,
} from "../../../packages/agent/tools/core/ls/directory-tree-contracts.ts"
import { isSlateDirectoryTreeNode } from "../../../packages/agent/tools/core/ls/directory-tree-contracts.ts"

function commandOf(command: TerminalMetadata_Command): SlateTerminalCommand {
  return {
    command: command.command,
    ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
    ...(command.timestampMs === undefined ? {} : { timestampMs: command.timestampMs }),
    ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }),
  }
}

function terminalMetadataOf(metadata: TerminalMetadata): SlateTerminalMetadata {
  return {
    ...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }),
    ...(metadata.lastModifiedMs === undefined ? {} : { lastModifiedMs: metadata.lastModifiedMs }),
    ...(metadata.lastCommands.length === 0 ? {} : { lastCommands: metadata.lastCommands.map(commandOf) }),
    ...(metadata.currentCommand === undefined ? {} : { currentCommand: commandOf(metadata.currentCommand) }),
  }
}

function fileOf(file: LsDirectoryTreeNode_File): SlateDirectoryTreeFile {
  return {
    name: file.name,
    ...(file.terminalMetadata === undefined ? {} : { terminalMetadata: terminalMetadataOf(file.terminalMetadata) }),
  }
}

function nodeOf(node: LsDirectoryTreeNode): SlateDirectoryTreeNode {
  return {
    absPath: node.absPath,
    childrenWereProcessed: node.childrenWereProcessed,
    childrenFiles: node.childrenFiles.map(fileOf),
    childrenDirs: node.childrenDirs.map(nodeOf),
    numFiles: node.numFiles,
    fullSubtreeExtensionCounts: { ...node.fullSubtreeExtensionCounts },
  }
}

/** Project the generated directory listing to the fields Slate's renderer needs. */
export function projectLsDirectoryTree(value: unknown): SlateDirectoryTreeNode | undefined {
  if (!isSlateDirectoryTreeNode(value)) return undefined
  const candidate = value as LsDirectoryTreeNode
  return nodeOf(candidate)
}
