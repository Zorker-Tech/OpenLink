export const MAX_OUTPUT_FILE_SIZE = 1_000_000
export const AGENT_TOOLS_DIR = ".slate/tools"

export interface BoundedToolOutput {
  readonly bytes: Uint8Array
  readonly lineCount: number
}

export function encodeBoundedToolOutput(text: string): BoundedToolOutput {
  const visibleText = text.length > MAX_OUTPUT_FILE_SIZE
    ? text.slice(0, MAX_OUTPUT_FILE_SIZE)
    : text
  return {
    bytes: new TextEncoder().encode(visibleText),
    lineCount: visibleText.split("\n").length,
  }
}
