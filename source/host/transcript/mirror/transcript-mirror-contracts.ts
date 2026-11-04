import type {
  DeferredTranscriptStep,
  PendingTranscriptCheckpoint,
  TranscriptCheckpoint,
} from "./transcript-journal-codec.ts";

export interface TranscriptOccurrence {
  readonly id: string;
  readonly line: string;
}

export interface TranscriptDeriver<Store> {
  derive(
    context: unknown,
    store: Store,
    previous: TranscriptCheckpoint,
    checkpoint: TranscriptCheckpoint,
    finalize: boolean,
    deferred?: DeferredTranscriptStep,
  ): Promise<{ readonly occurrences: readonly TranscriptOccurrence[]; readonly deferredStep?: DeferredTranscriptStep }>;
  initial(context: unknown, store: Store, checkpoint: TranscriptCheckpoint): Promise<readonly TranscriptOccurrence[]>;
}

export interface JournalOutcome {
  readonly op: string;
  readonly outcome: "ok" | "failed";
  readonly conversationId: string;
  readonly entryCount?: number;
  readonly bytes?: number;
  readonly durationMs: number;
  readonly cause?: unknown;
}

export interface TranscriptFileState {
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
}

export type PendingCheckpoint = PendingTranscriptCheckpoint;
