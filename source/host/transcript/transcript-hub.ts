/**
 * The contracts the transcript extension graph is built against.
 *
 * One line of a transcript is an entry; a session is a transcript on disk with the store that owns it; and the pieces
 * that need a runner, a store or a set of timers meet here, with the error the platform raises when the runner factory
 * was never attached.
 */

/** The one thing the platform says when a transcript asked for a runner it was never given. */
export const RUNNER_UNATTACHED_MESSAGE = "Slate agent runner factory is not attached.";

/** The time and timers the platform runs on, injectable so that a caller can drive them. */
export interface Clock {
  now(): number;
  schedule(delay: number, run: () => void): Disposable;
}

/** Something that is held for later release. */
export interface Disposable {
  dispose(): void;
}

/** A timer as the clock hands it out: cancelling it is the only thing a caller may do with it. */
function timerToDispose(timer: ReturnType<typeof setTimeout>): Disposable {
  return { dispose: () => clearTimeout(timer) };
}

/** The real clock: the time as the runtime tells it, and timers the runtime schedules. */
export const realClock: Clock = {
  now: Date.now,
  schedule(delay, run) {
    return timerToDispose(setTimeout(run, delay));
  },
};

/** One line of a transcript: a message, a notice, a tool call, or anything a handler has added to it. */
export interface TranscriptEntry {
  readonly id: string;
  readonly kind: string;
  readonly role?: string;
  readonly content?: string;
  readonly timestampMs?: number;
  readonly [member: string]: unknown;
}

/** What a session can do with the store behind its transcript. */
interface TranscriptDatabase {
  getTranscriptEntries(): TranscriptEntry[];
  appendTranscriptEntry?(record: TranscriptEntry): void;
  updateTranscriptEntry?(id: string, change: (record: TranscriptEntry) => TranscriptEntry): TranscriptEntry | null;
}

/** A transcript session as the extensions receive it: its identity, where it is stored, and its store when it has one. */
export interface TranscriptSession {
  readonly id: string;
  readonly dbPath: string;
  readonly db?: TranscriptDatabase;
  readonly [member: string]: unknown;
}

/** The transcript manager as the extensions see it; each extension uses the members it needs. */
export type TranscriptManagerLike = Record<string, any>;
