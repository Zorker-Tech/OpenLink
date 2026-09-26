/**
 * The transport a host is reached over, and what it remembers about the last message it sent.
 *
 * An update is handed to whatever ingests it, and the id the transport assigned is remembered for the two kinds of
 * update that answer something the user sent: the message that was sent, and whether a reaction landed.
 */
export interface SlateUpdate { type: string; [key: string]: unknown }
export function createSlateTransport(ingest: (update: SlateUpdate) => string | undefined) {
  let lastSentMessageId: string | undefined; let lastReactionApplied = false;
  return { onUpdate(update: SlateUpdate): void { const assignedId = ingest(update); if (update.type === "send-message") lastSentMessageId = assignedId; else if (update.type === "react-to-message") lastReactionApplied = assignedId != null; }, lastSentMessageId: () => lastSentMessageId, lastReactionApplied: () => lastReactionApplied };
}
