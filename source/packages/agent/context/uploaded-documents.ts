/**
 * Telling the agent about documents the user uploaded.
 *
 * An upload lands on the workspace's filesystem rather than in the message, so the agent would have no
 * way to know it exists. The block names each document by path and says where they came from, which is
 * enough for the agent to read them with the tools it already has — no second mechanism, and no content
 * copied into the conversation.
 */

export interface UploadedDocumentInfo {
  readonly path: string
}

export function renderUploadedDocumentsContext(documents: readonly UploadedDocumentInfo[]): string | undefined {
  if (documents.length === 0) return undefined
  const documentsList = documents.map(document => `- ${document.path}`).join("\n")
  return `<uploaded_documents>
The following documents have been saved to your filesystem. You can read them using your file-reading tool or other tools:
${documentsList}
</uploaded_documents>`
}
