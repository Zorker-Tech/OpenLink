/**
 * A notebook written out the way a reader wants it.
 *
 * The reader wants the cells in order, each with its source and its output, and the outputs are the part
 * that needs deciding: an error's traceback is the useful part of an error, a result's text or markdown
 * representation is the useful part of a result, and both are often longer than the cell itself. So each
 * cell's output is capped — the cap is on the output rather than on the whole notebook, because a
 * notebook with many small cells should not lose its last ones to one chatty cell — and a capped output
 * says it was capped.
 *
 * A notebook that does not parse is passed through as it came: a broken notebook is still better read as
 * text than not at all.
 */

import { extractCellSource, tryParseNotebook, type NotebookCellOutput } from "../notebook-utils.ts"

const MAX_OUTPUT_CHARS_PER_CELL = 2_000

function extractTextFromData(data: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["text/plain", "text/markdown"] as const) {
    const value = data[key]
    if (value) {
      if (typeof value === "string") return value
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join("")
    }
  }
  return undefined
}

function extractOutputText(output: NotebookCellOutput): string | undefined {
  // A traceback carries terminal colour codes that mean nothing in a prompt.
  if (output.output_type === "error" && output.traceback) {
    const escape = String.fromCharCode(27)
    const ansiPattern = new RegExp(`${escape}\\[[0-9;]*m`, "g")
    return output.traceback.map(line => line.replace(ansiPattern, "")).join("\n")
  }
  if (
    (output.output_type === "execute_result" || output.output_type === "display_data") &&
    output.data !== undefined
  ) {
    return extractTextFromData(output.data)
  }
  if (typeof output.text === "string") return output.text
  if (Array.isArray(output.text)) {
    const stringElements = output.text.filter((item): item is string => typeof item === "string")
    return stringElements.length > 0 ? stringElements.join("") : undefined
  }
  return undefined
}

export function formatNotebookForLLM(rawContent: string): string {
  const notebook = tryParseNotebook(rawContent)
  if (!notebook) return rawContent

  const formattedCells: string[] = []
  notebook.cells.forEach((cell, index) => {
    const source = extractCellSource(cell)
    const cellParts = [`\nCell ${index}:\n\`\`\`\n${source}\`\`\``]
    if (cell.outputs && cell.outputs.length > 0) {
      let outputText = ""
      for (const output of cell.outputs) {
        // Stop collecting once the cap is reached rather than collecting and then cutting.
        if (outputText.length >= MAX_OUTPUT_CHARS_PER_CELL) break
        const extractedText = extractOutputText(output)
        if (extractedText) {
          if (outputText.length > 0 && !outputText.endsWith("\n")) outputText += "\n"
          outputText += extractedText
        }
      }
      if (outputText.length > 0) {
        const isTruncated = outputText.length > MAX_OUTPUT_CHARS_PER_CELL
        outputText = outputText.substring(0, MAX_OUTPUT_CHARS_PER_CELL)
        const outputHeader = `Cell ${index} output${isTruncated ? ` (truncated at ${MAX_OUTPUT_CHARS_PER_CELL} chars)` : ""}:`
        cellParts.push(`${outputHeader}\n\`\`\`\n${outputText}\`\`\``)
      }
    }
    formattedCells.push(cellParts.join("\n\n"))
  })
  if (formattedCells.length === 0) return "Notebook is empty (0 cells)"
  return `${formattedCells.join("\n\n")}\n\n`
}
