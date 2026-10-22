/**
 * Documentation the platform found for the question, as context.
 *
 * A chunk is only useful if it can be traced back: the agent is asked to answer as if it knows this
 * material, so the page it came from and the document it belongs to travel with it. The list is rendered
 * with a separator per chunk because chunks are not a document — they are passages that may come from
 * different pages entirely.
 */

export interface DocumentationChunk {
  readonly docName: string
  readonly pageUrl: string
  readonly documentationChunk: string
}

export interface DocumentationResult {
  readonly chunks: readonly DocumentationChunk[]
}

const CONTEXT_OPEN = `<documentation_context>
## Potentially Relevant Documentation:
-------
`
const CONTEXT_CLOSE = `</documentation_context>`

/** A chunk is rendered as itself, then a rule, so two passages cannot be read as one. */
const CHUNK_RULE = `____

`

/** What one chunk says: the document it belongs to, the page it came from, and the passage itself. */
function renderChunk(chunk: DocumentationChunk): string {
  return `Document Name: ${chunk.docName}
Document URL: ${chunk.pageUrl}
Document content:
${chunk.documentationChunk}
${CHUNK_RULE}`
}

/**
 * The documentation a question found, as the context a prompt carries, and nothing when nothing was found.
 *
 * The open and close carry no trailing rule: the passage before the close still ends with its own.
 */
export function renderDocumentationContext(result: DocumentationResult | undefined): string | undefined {
  if (result === undefined || result.chunks.length === 0) return undefined
  return `${CONTEXT_OPEN}${result.chunks.map(renderChunk).join("")}${CONTEXT_CLOSE}`
}
