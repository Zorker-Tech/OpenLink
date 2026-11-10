export const SHELL_CHAR_HARD_LIMIT = 20_000

export interface LimitedTerminalOutput {
  readonly output: string
  readonly truncated: boolean
}

export function limitTerminalOutput(
  output: string,
  maxLength: number,
  keepBothEnds: boolean,
): LimitedTerminalOutput {
  if (output.length <= maxLength) return { output, truncated: false }
  if (!keepBothEnds) return { output: `${output.substring(0, maxLength)}\n\n... (output truncated)`, truncated: true }

  const endLength = Math.floor(maxLength / 2)
  return {
    output: `${output.substring(0, endLength)}\n\n... (output truncated) ...\n\n${output.substring(output.length - endLength)}`,
    truncated: true,
  }
}
