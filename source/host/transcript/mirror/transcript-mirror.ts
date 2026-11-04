/** Durable journal-backed transcript mirror and its checkpoint transaction lifecycle. */

import {
  checkpointIdentity,
  TranscriptJournalCorruptionError,
  type DeferredTranscriptStep,
  type TranscriptCheckpoint,
} from "./transcript-journal-codec.ts";
import { MirrorRouter, type LegacyMirrorPort } from "./transcript-mirror-router.ts";
import { SlateError } from "../../../shared/errors/registry.ts";
import { TranscriptMirrorFiles } from "./transcript-mirror-files.ts";
import {
  serializeTranscriptWrite,
} from "./transcript-mirror-write-lanes.ts";
import type {
  JournalOutcome,
  TranscriptDeriver,
  TranscriptFileState,
  TranscriptOccurrence,
} from "./transcript-mirror-contracts.ts";
import { TranscriptMirrorOutcomeReporter } from "./transcript-mirror-outcomes.ts";

export type { JournalOutcome, TranscriptDeriver, TranscriptFileState, TranscriptOccurrence } from "./transcript-mirror-contracts.ts";

export class FileTranscriptMirror<Store = unknown> {
  readonly states = new Map<string, TranscriptFileState>();
  readonly durableCheckpoints = new Map<string, TranscriptCheckpoint>();
  readonly preparedCheckpoints = new Map<string, TranscriptCheckpoint>();
  readonly deferredSteps = new Map<string, DeferredTranscriptStep>();
  readonly preparedDeferredSteps = new Map<string, DeferredTranscriptStep | null>();
  readonly routes = new Map<string, Promise<"journal" | "legacy">>();
  readonly reportedFailures = new WeakSet<object>();
  private readonly files: TranscriptMirrorFiles;
  private readonly outcomeReporter: TranscriptMirrorOutcomeReporter;

  constructor(
    readonly transcriptsDir: string,
    readonly reportOutcome: (outcome: JournalOutcome) => void = () => {},
    readonly deriver?: TranscriptDeriver<Store>,
  ) {
    this.files = new TranscriptMirrorFiles(transcriptsDir);
    this.outcomeReporter = new TranscriptMirrorOutcomeReporter(reportOutcome, this.reportedFailures);
  }

  private requireDeriver(): TranscriptDeriver<Store> {
    if (this.deriver == null) {
      throw new TranscriptJournalCorruptionError("transcript occurrence derivation is unavailable");
    }
    return this.deriver;
  }

  routed(legacy: LegacyMirrorPort<TranscriptCheckpoint, Store>, enabled: () => Promise<boolean>): MirrorRouter<TranscriptCheckpoint, Store> {
    return new MirrorRouter(this, legacy, enabled, this.routes);
  }

  jsonlPathFor(id: string): string {
    return this.files.jsonlPathFor(id);
  }

  pendingPathFor(id: string): string {
    return this.files.pendingPathFor(id);
  }

  cursorPathFor(id: string): string {
    return this.files.cursorPathFor(id);
  }

  modePathFor(id: string): string {
    return this.files.modePathFor(id);
  }

  async ownsConversation(id: string): Promise<boolean> {
    return this.files.ownsConversation(id);
  }

  async claimConversation(id: string): Promise<void> {
    await this.files.claimConversation(id);
  }

  recover(context: unknown, id: string, checkpoint: TranscriptCheckpoint, store: Store): Promise<unknown> {
    return this.serialize(id, () => this.outcomeReporter.run(
      "replay",
      id,
      (errno) => SlateError.journalReplayFailed({ errno }),
      async () => {
        const pending = await this.files.readPending(id);
        let state = this.states.get(id);
        const checkpointHash = checkpointIdentity(checkpoint);

        if (pending != null) {
          if (pending.checkpointHash === checkpointHash) {
            state = await this.files.appendPending(id, pending);
            await this.files.writeDeferred(id, pending.cursor.deferredStep);
            await this.files.removePending(id);
          } else if (pending.previousCheckpointHash === checkpointHash) {
            await this.files.removePending(id);
          } else {
            throw new TranscriptJournalCorruptionError("pending transcript WAL does not match the durable checkpoint");
          }
        }

        state ??= await this.initialize(context, id, checkpoint, store);
        this.states.set(id, state);
        this.durableCheckpoints.set(id, checkpoint);
        this.preparedCheckpoints.delete(id);
        this.preparedDeferredSteps.delete(id);

        const deferred = await this.files.readDeferred(id);
        if (deferred == null) this.deferredSteps.delete(id);
        else {
          if (checkpoint.turns[deferred.turnIndex] == null) {
            throw new TranscriptJournalCorruptionError("deferred transcript step is absent from the durable checkpoint");
          }
          this.deferredSteps.set(id, deferred);
        }
        return {};
      },
    ));
  }

  prepareCheckpoint(
    context: unknown,
    id: string,
    checkpoint: TranscriptCheckpoint,
    store: Store,
    finalize = false,
  ): Promise<unknown> {
    return this.serialize(id, () => this.outcomeReporter.run(
      "checkpoint",
      id,
      (errno) => SlateError.journalCheckpointFailed({ errno }),
      async () => {
        if (await this.files.readPending(id) != null) {
          throw new TranscriptJournalCorruptionError("pending transcript checkpoint must recover before preparing another");
        }

        const previous = this.durableCheckpoints.get(id);
        const state = this.states.get(id);
        if (previous == null || state == null) {
          throw new TranscriptJournalCorruptionError("transcript checkpoint must recover before preparing");
        }

        const current = await this.files.currentIdentity(id);
        if (current.size !== state.bytes || current.device !== state.device || current.inode !== state.inode) {
          throw new TranscriptJournalCorruptionError("canonical transcript changed outside the journal");
        }

        const derivation = await this.requireDeriver().derive(
          context,
          store,
          previous,
          checkpoint,
          finalize,
          this.deferredSteps.get(id),
        );
        const seen = new Set<string>();
        const lines = derivation.occurrences.map((occurrence) => {
          if (seen.has(occurrence.id)) {
            throw new TranscriptJournalCorruptionError(`transcript occurrence ${occurrence.id} was derived twice`);
          }
          seen.add(occurrence.id);
          return occurrence.line;
        });
        const pending = {
          version: 1 as const,
          previousCheckpointHash: checkpointIdentity(previous),
          checkpointHash: checkpointIdentity(checkpoint),
          appendOffset: state.bytes,
          fileDevice: state.device,
          fileInode: state.inode,
          lines,
          cursor: {
            turnCount: checkpoint.turns.length,
            ...(derivation.deferredStep == null ? {} : { deferredStep: derivation.deferredStep }),
          },
        };
        const bytes = Buffer.from(JSON.stringify(pending));
        await this.files.installAtomic(this.files.pendingPathFor(id), bytes);
        this.preparedCheckpoints.set(id, checkpoint);
        this.preparedDeferredSteps.set(id, derivation.deferredStep ?? null);
        return { entryCount: lines.length, bytes: bytes.byteLength };
      },
    ));
  }

  commitCheckpoint(_context: unknown, id: string): Promise<unknown> {
    return this.serialize(id, () => this.outcomeReporter.run(
      "append",
      id,
      (errno) => SlateError.journalAppendFailed({ errno }),
      async () => {
        const pending = await this.files.readPending(id);
        const checkpoint = this.preparedCheckpoints.get(id);
        if (pending == null) throw new TranscriptJournalCorruptionError("prepared transcript WAL is missing at commit");
        if (checkpoint == null || !this.preparedDeferredSteps.has(id)) {
          throw new TranscriptJournalCorruptionError("prepared transcript checkpoint is missing in memory");
        }

        const deferred = this.preparedDeferredSteps.get(id) ?? undefined;
        const state = await this.files.appendPending(id, pending);
        await this.files.writeDeferred(id, deferred);
        await this.files.removePending(id);
        this.preparedCheckpoints.delete(id);
        this.preparedDeferredSteps.delete(id);
        this.durableCheckpoints.set(id, checkpoint);
        if (deferred == null) this.deferredSteps.delete(id);
        else this.deferredSteps.set(id, deferred);
        return { entryCount: pending.lines.length, bytes: state.bytes - pending.appendOffset };
      },
    ));
  }

  abortCheckpoint(_context: unknown, id: string): Promise<void> {
    return this.serialize(id, async () => {
      this.preparedCheckpoints.delete(id);
      this.preparedDeferredSteps.delete(id);
      await this.files.removePending(id);
    });
  }

  skipCheckpoint(
    context: unknown,
    id: string,
    checkpoint: TranscriptCheckpoint,
    store: Store,
  ): Promise<void> {
    return this.serialize(id, async () => {
      this.preparedCheckpoints.delete(id);
      this.preparedDeferredSteps.delete(id);
      this.deferredSteps.delete(id);
      await this.files.removePending(id);
      await this.files.writeDeferred(id);
      this.durableCheckpoints.set(id, checkpoint);
    });
  }

  private initialize(context: unknown, id: string, checkpoint: TranscriptCheckpoint, store: Store): Promise<TranscriptFileState> {
    return this.files.initialize(id, checkpoint, () => this.requireDeriver().initial(context, store, checkpoint));
  }

  private serialize<Result>(id: string, operation: () => Promise<Result>): Promise<Result> {
    return serializeTranscriptWrite(this.files.jsonlPathFor(id), operation);
  }
}
