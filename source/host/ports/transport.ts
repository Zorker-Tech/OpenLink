/**
 * The transport a host is reached over, and what it remembers about the last message it sent.
 *
 * An update is handed to whatever ingests it, and the id the transport assigned is remembered for the two kinds of
 * update that answer something the user sent: the message that was sent, and whether a reaction landed.
 */
export interface SlateUpdate { type: string; [key: string]: unknown }

/** What the transport remembers about the last send and the last reaction it carried. */
interface SlateTransportMemory {
  lastSentMessageId: string | undefined;
  lastReactionApplied: boolean;
}

export function createSlateTransport(ingest: (update: SlateUpdate) => string | undefined) {
  const memory: SlateTransportMemory = { lastSentMessageId: undefined, lastReactionApplied: false };
  const recordUpdate = (update: SlateUpdate): void => {
    const assignedId = ingest(update);
    if (update.type === "send-message") memory.lastSentMessageId = assignedId;
    else if (update.type === "react-to-message") memory.lastReactionApplied = assignedId != null;
  };
  return {
    onUpdate: recordUpdate,
    lastSentMessageId: () => memory.lastSentMessageId,
    lastReactionApplied: () => memory.lastReactionApplied,
  };
}
