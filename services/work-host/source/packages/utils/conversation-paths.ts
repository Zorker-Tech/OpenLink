/**
 * Where a conversation's files live, and how a conversation id becomes one.
 *
 * Transcripts are addressed by conversation id, and that id comes from a model or a backend — it can hold slashes,
 * dots or anything else. It is encoded before it is used as a path component, and bounded in length, so no id can
 * escape its directory or produce a name the filesystem rejects.
 */

/** The directory transcripts live in, under the conversation's own one. */
export const TRANSCRIPTS_SUBDIR = "agent-transcripts";

/** The most characters a conversation id may take in a path component. */
export const MAX_CONVERSATION_ID_LENGTH = 200;

/** An id encoded into a single path component: the percent escapes' marker becomes an underscore. */
function encodePathComponent(id: string): string {
  return encodeURIComponent(id).replace(/%/g, "_");
}

/** A path component cut to the length a conversation id may take, when it is longer than that. */
function boundedComponent(component: string): string {
  if (component.length <= MAX_CONVERSATION_ID_LENGTH) return component;
  return component.slice(0, MAX_CONVERSATION_ID_LENGTH);
}

/** A conversation's id as the single path component its files live under. */
export function getSafeConversationId(id: string): string {
  return boundedComponent(encodePathComponent(id));
}
