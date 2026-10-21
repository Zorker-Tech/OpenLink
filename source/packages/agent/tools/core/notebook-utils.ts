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

/** Text the format may write as one string or as a line per element. */
const LINES_OR_TEXT = z.union([z.string(), z.array(z.string())])

const CELL_OUTPUT = z.object({
  output_type: z.string().optional(),
  text: LINES_OR_TEXT.optional(),
  data: z.record(z.unknown()).optional(),
  ename: z.string().optional(),
  evalue: z.string().optional(),
  traceback: z.array(z.string()).optional(),
})

const CELL = z.object({
  cell_type: z.enum(["code", "markdown", "raw"]),
  metadata: z.record(z.unknown()).optional().default({}),
  source: LINES_OR_TEXT,
  execution_count: z.union([z.number(), z.null()]).optional(),
  outputs: z.array(CELL_OUTPUT).optional(),
  id: z.string().optional(),
})

const NOTEBOOK = z.object({
  cells: z.array(CELL),
  metadata: z.record(z.unknown()).optional().default({}),
  nbformat: z.number().optional(),
  nbformat_minor: z.number().optional(),
})

export type NotebookCellOutput = z.infer<typeof CELL_OUTPUT>
export type NotebookCell = z.infer<typeof CELL>
export type Notebook = z.infer<typeof NOTEBOOK>

export type NotebookParseResult =
  | { readonly success: true; readonly notebook: Notebook }
  | { readonly success: false; readonly error: string; readonly errorDetails: string }

/** What was wrong with a notebook, one `field: reason` per issue, in the order the validator found them. */
function describeIssues(issues: readonly { readonly path: readonly (string | number | symbol)[]; readonly message: string }[]): string {
  return issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", ")
}

/**
 * A notebook read from the text a file holds.
 *
 * Text that is not JSON and text that is JSON of the wrong shape are told apart, because the two mean different things
 * to whoever has to fix the file: one is a broken file, the other a notebook whose fields were not what they must be.
 */
export function parseNotebook(rawContent: string): NotebookParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent) as unknown
  } catch {
    return {
      success: false,
      error: "Failed to parse notebook as JSON",
      errorDetails: "The notebook file is not valid JSON",
    }
  }
  const validated = NOTEBOOK.safeParse(parsed)
  if (!validated.success) {
    const wrong = describeIssues(validated.error.issues)
    return {
      success: false,
      error: `Invalid notebook structure: ${wrong}`,
      errorDetails: `The notebook file does not match the expected Jupyter notebook format: ${wrong}`,
    }
  }
  return { success: true, notebook: validated.data }
}

/** The notebook in this text, or nothing when it is not one. */
export function tryParseNotebook(rawContent: string): Notebook | undefined {
  const result = parseNotebook(rawContent)
  return result.success ? result.notebook : undefined
}

/** A cell's source as one piece of text: the format's line-per-element is not something to hand on. */
export function extractCellSource(cell: NotebookCell): string {
  const { source } = cell
  return Array.isArray(source) ? source.join("") : source || ""
}

export function isJupyterNotebook(filePath: string): boolean {
  return filePath.endsWith(".ipynb")
}
