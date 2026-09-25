/**
 * Reading a Jupyter notebook as what it is.
 *
 * A notebook is JSON with a documented shape, and reading it as text gives the model the JSON rather than
 * the work: cell sources are arrays of lines, outputs are typed structures, and metadata is noise. So the
 * shape is validated on the way in — with a message naming the fields that were wrong, since a notebook
 * that does not parse is usually one that was edited by hand — and the parts worth showing are extracted
 * from it.
 *
 * A cell's source is joined rather than left as an array, because a line per element is an artifact of the
 * format and not something the model should have to reassemble.
 */

import { z } from "zod"

const notebookCellOutputSchema = z.object({
  output_type: z.string().optional(),
  text: z.union([z.string(), z.array(z.string())]).optional(),
  data: z.record(z.unknown()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
})

const notebookCellSchema = z.object({
  cell_type: z.enum(["code", "markdown", "raw"]),
  metadata: z.record(z.unknown()).optional().default({}),
  source: z.union([z.string(), z.array(z.string())]),
  execution_count: z.union([z.number(), z.null()]).optional(),
  outputs: z.array(notebookCellOutputSchema).optional(),
  id: z.string().optional(),
})

const notebookSchema = z.object({
  cells: z.array(notebookCellSchema),
  metadata: z.record(z.unknown()).optional().default({}),
  nbformat: z.number().optional(),
  nbformat_minor: z.number().optional(),
})

export type NotebookCellOutput = z.infer<typeof notebookCellOutputSchema>
export type NotebookCell = z.infer<typeof notebookCellSchema>
export type Notebook = z.infer<typeof notebookSchema>

export type NotebookParseResult =
  | { readonly success: true; readonly notebook: Notebook }
  | { readonly success: false; readonly error: string; readonly errorDetails: string }

export function parseNotebook(rawContent: string): NotebookParseResult {
  let notebookData: unknown
  try {
    notebookData = JSON.parse(rawContent) as unknown
  } catch (_parseError) {
    return {
      success: false,
      error: "Failed to parse notebook as JSON",
      errorDetails: "The notebook file is not valid JSON",
    }
  }
  const parseResult = notebookSchema.safeParse(notebookData)
  if (!parseResult.success) {
    const errorMessages = parseResult.error.issues
      .map(issue => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ")
    return {
      success: false,
      error: `Invalid notebook structure: ${errorMessages}`,
      errorDetails: `The notebook file does not match the expected Jupyter notebook format: ${errorMessages}`,
    }
  }
  return { success: true, notebook: parseResult.data }
}

export function tryParseNotebook(rawContent: string): Notebook | undefined {
  const result = parseNotebook(rawContent)
  return result.success ? result.notebook : undefined
}

export function extractCellSource(cell: NotebookCell): string {
  const source = cell.source
  return Array.isArray(source) ? source.join("") : source || ""
}

export function isJupyterNotebook(filePath: string): boolean {
  return filePath.endsWith(".ipynb")
}
