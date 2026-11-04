import type { SlateTerminalCommand, SlateTerminalMetadata } from "./directory-tree-contracts.ts"

function timestamp(value: bigint): string {
  return new Date(Number(value)).toISOString()
}

function commandDetails(command: SlateTerminalCommand): string {
  const segments = [
    command.command,
    command.exitCode === undefined ? undefined : `exit: ${command.exitCode}`,
    command.timestampMs === undefined ? undefined : `time: ${timestamp(command.timestampMs)}`,
    command.durationMs === undefined ? undefined : `duration: ${command.durationMs}ms`,
  ]
  return segments.filter(Boolean).join(", ")
}

export function formatTerminalMetadata(metadata: SlateTerminalMetadata, indentation: string): string {
  const lines: string[] = []
  if (metadata.cwd) lines.push(`${indentation}cwd: ${metadata.cwd}\n`)
  if (metadata.lastModifiedMs) lines.push(`${indentation}last modified: ${timestamp(metadata.lastModifiedMs)}\n`)

  if (metadata.lastCommands !== undefined && metadata.lastCommands.length > 0) {
    lines.push(`${indentation}last commands:\n`)
    for (const command of metadata.lastCommands) lines.push(`${indentation}  - ${commandDetails(command)}\n`)
  }
  if (metadata.currentCommand !== undefined) {
    lines.push(`${indentation}current command:\n`, `${indentation}  - ${commandDetails(metadata.currentCommand)}\n`)
  }
  return lines.join("")
}
