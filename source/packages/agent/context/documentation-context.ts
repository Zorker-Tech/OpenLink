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

export function renderDocumentationContext(result: DocumentationResult | undefined): string | undefined {
  if (result === undefined || result.chunks.length === 0) return undefined
  let docsText = `<documentation_context>
## Potentially Relevant Documentation:
-------
`
  for (const chunk of result.chunks) {
    docsText += `Document Name: ${chunk.docName}
Document URL: ${chunk.pageUrl}
Document content:
${chunk.documentationChunk}
____

`
  }
  docsText += `</documentation_context>`
  return docsText
}
