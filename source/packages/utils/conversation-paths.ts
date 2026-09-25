/**
 * Where a conversation's files live, and how a conversation id becomes one.
 *
 * Transcripts are addressed by conversation id, and that id comes from a model or a backend — it can
 * hold slashes, dots or anything else. It is encoded before it is used as a path component, and
 * bounded in length, so no id can escape its directory or produce a name the filesystem rejects.
 */

export const TRANSCRIPTS_SUBDIR = "agent-transcripts"
export const MAX_CONVERSATION_ID_LENGTH = 200

export function getSafeConversationId(conversationId: string): string {
  let safe = encodeURIComponent(conversationId).replace(/%/g, "_")
  if (safe.length > MAX_CONVERSATION_ID_LENGTH) safe = safe.slice(0, MAX_CONVERSATION_ID_LENGTH)
  return safe
}
