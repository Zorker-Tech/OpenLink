import type { NotebookCellOutput } from "../notebook-utils.ts"

export const MAX_OUTPUT_CHARS_PER_CELL = 2_000

export interface NotebookOutputText {
  readonly text: string
  readonly truncated: boolean
}

function textFromData(data: Readonly<Record<string, unknown>>): string | undefined {
  for (const mediaType of ["text/plain", "text/markdown"] as const) {
    const payload = data[mediaType]
    if (typeof payload === "string") return payload
    if (Array.isArray(payload)) {
      return payload.filter((piece): piece is string => typeof piece === "string").join("")
    }
  }
  return undefined
}

function textFromOutput(output: NotebookCellOutput): string | undefined {
  if (output.output_type === "error" && output.traceback !== undefined) {
    const escapeCode = String.fromCharCode(27)
    const colorSequence = new RegExp(escapeCode + "\\[[0-9;]*m", "g")
    return output.traceback.map(line => line.replace(colorSequence, "")).join("\n")
  }

  if (
    (output.output_type === "execute_result" || output.output_type === "display_data") &&
    output.data !== undefined
  ) {
    return textFromData(output.data)
  }
  if (typeof output.text === "string") return output.text
  if (Array.isArray(output.text)) {
    const pieces = output.text.filter((piece): piece is string => typeof piece === "string")
    return pieces.length === 0 ? undefined : pieces.join("")
  }
  return undefined
}

export function projectNotebookOutputText(outputs: readonly NotebookCellOutput[]): NotebookOutputText {
  let text = ""
  let truncated = false

  for (const output of outputs) {
    const piece = textFromOutput(output)
    if (piece === undefined || piece.length === 0) continue

    const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
    const addition = separator + piece
    const available = MAX_OUTPUT_CHARS_PER_CELL - text.length
    if (addition.length > available) {
      text += addition.slice(0, available)
      truncated = true
      break
    }
    text += addition
  }
  return { text, truncated }
}
