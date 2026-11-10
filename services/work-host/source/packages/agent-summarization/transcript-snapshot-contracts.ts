import type { Context } from "../context/context.ts";
import type { RedactedCoreMessage } from "./summarization-handler.ts";

export interface TranscriptSnapshotOptions {
  readonly characterLimit: number;
}

export interface TranscriptSnapshot {
  readonly text: string;
  readonly wholeMessages: number;
  readonly shortenedMessages: number;
  readonly omittedMessages: number;
}

export interface TranscriptSnapshotInput {
  readonly context: Context;
  readonly messages: readonly RedactedCoreMessage[];
  readonly options: TranscriptSnapshotOptions;
}
