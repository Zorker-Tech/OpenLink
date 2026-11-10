/**
 * Telling the agent about documents the user uploaded.
 *
 * An upload lands on the workspace's filesystem rather than in the message, so the agent would have no way to know it
 * exists. The block names each document by path and says where they came from, which is enough for the agent to read
 * them with the tools it already has — no second mechanism, and no content copied into the conversation.
 */

/** The tag the block is wrapped in, and the line that introduces the list. */
const UPLOADED_DOCUMENTS_OPEN = "<uploaded_documents>";
const UPLOADED_DOCUMENTS_CLOSE = "</uploaded_documents>";
const UPLOADED_DOCUMENTS_NOTICE =
  "The following documents have been saved to your filesystem. You can read them using your file-reading tool or other tools:";

/** What one uploaded document is: where it landed on the filesystem. */
export interface UploadedDocumentInfo {
  readonly path: string;
}

/** One uploaded document as a line of the context block. */
function documentLine(document: UploadedDocumentInfo): string {
  return `- ${document.path}`;
}

/** The block that names the uploaded documents, or undefined when the turn carried none. */
export function renderUploadedDocumentsContext(uploaded: readonly UploadedDocumentInfo[]): string | undefined {
  if (uploaded.length === 0) return undefined;
  const list = uploaded.map(documentLine).join("\n");
  return `${UPLOADED_DOCUMENTS_OPEN}\n${UPLOADED_DOCUMENTS_NOTICE}\n${list}\n${UPLOADED_DOCUMENTS_CLOSE}`;
}
