import { extractCellSource, tryParseNotebook, type NotebookCell } from "../notebook-utils.ts"
import { MAX_OUTPUT_CHARS_PER_CELL, projectNotebookOutputText } from "./notebook-output-projection.ts"

const CODE_FENCE = String.fromCharCode(96).repeat(3)

function formatNotebookCell(index: number, cell: NotebookCell): string {
  const opening = "\nCell " + index + ":\n" + CODE_FENCE + "\n"
  const sections = [opening + extractCellSource(cell) + CODE_FENCE]
  if (cell.outputs === undefined || cell.outputs.length === 0) return sections[0]!

  const output = projectNotebookOutputText(cell.outputs)
  if (output.text.length === 0) return sections[0]!
  const truncation = output.truncated ? " (truncated at " + MAX_OUTPUT_CHARS_PER_CELL + " chars)" : ""
  sections.push(
    "Cell " + index + " output" + truncation + ":\n" + CODE_FENCE + "\n" + output.text + CODE_FENCE,
  )
  return sections.join("\n\n")
}

export function formatNotebookForLLM(rawContent: string): string {
  const notebook = tryParseNotebook(rawContent)
  if (notebook === undefined) return rawContent
  if (notebook.cells.length === 0) return "Notebook is empty (0 cells)"

  const formatted = notebook.cells.map((cell, index) => formatNotebookCell(index, cell))
  return formatted.join("\n\n") + "\n\n"
}
