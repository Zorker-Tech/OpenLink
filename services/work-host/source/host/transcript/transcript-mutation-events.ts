/**
 * Telling whoever cares that a transcript changed.
 *
 * Listeners are told about a change as it happens, and one listener that throws does not keep the others from being
 * told — a change to a transcript is not a place where one observer can stop the rest.
 */

/** A transcript change: what kind it is, and whatever the change carries. */
export interface TranscriptMutation { kind: string; [key: string]: unknown }

/** The function a change is told to. */
type TranscriptMutationListener = (mutation: TranscriptMutation) => void;

/** Whoever is listening for transcript changes right now. */
const subscribers = new Set<TranscriptMutationListener>();

/** Start listening for transcript changes, and answer the way to stop. */
export function subscribeTranscriptMutations(listener: TranscriptMutationListener): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Tell one listener, without letting its failure reach the others. */
function tellListener(listener: TranscriptMutationListener, mutation: TranscriptMutation): void {
  try {
    listener(mutation);
  } catch {}
}

/** Tell every listener about a change, in the order they started listening. */
export function publishTranscriptMutation(mutation: TranscriptMutation): void {
  for (const listener of subscribers) tellListener(listener, mutation);
}
