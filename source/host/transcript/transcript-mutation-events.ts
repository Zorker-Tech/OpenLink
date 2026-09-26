/**
 * Telling whoever cares that a transcript changed.
 *
 * Listeners are told about a change as it happens, and one listener that throws does not keep the others from being
 * told — a change to a transcript is not a place where one observer can stop the rest.
 */
export interface TranscriptMutation { kind: string; [key: string]: unknown }
const listeners = new Set<(mutation: TranscriptMutation) => void>();
export function subscribeTranscriptMutations(listener: (mutation: TranscriptMutation) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function publishTranscriptMutation(mutation: TranscriptMutation): void { for (const listener of listeners) { try { listener(mutation); } catch {} } }
