export interface SlateTerminalCommand {
  readonly command: string
  readonly exitCode?: number
  readonly timestampMs?: bigint
  readonly durationMs?: bigint
}

export interface SlateTerminalMetadata {
  readonly cwd?: string
  readonly lastModifiedMs?: bigint
  readonly lastCommands?: readonly SlateTerminalCommand[]
  readonly currentCommand?: SlateTerminalCommand
}

export interface SlateDirectoryTreeFile {
  readonly name: string
  readonly terminalMetadata?: SlateTerminalMetadata
}

export interface SlateDirectoryTreeNode {
  readonly absPath: string
  readonly childrenWereProcessed: boolean
  readonly childrenFiles: readonly SlateDirectoryTreeFile[]
  readonly childrenDirs: readonly SlateDirectoryTreeNode[]
  readonly numFiles: number
  readonly fullSubtreeExtensionCounts: Readonly<Record<string, number>>
}

export interface DirectoryTreeRenderResult {
  readonly result: string
  readonly atLeastOneExtensionCountRendered: boolean
}
