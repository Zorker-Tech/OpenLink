/**
 * Which mirror a conversation's transcript is written through.
 *
 * A conversation is written by one of two writers — the journal, or the store that predates it — and once a conversation
 * belongs to the journal it stays there: turning the journal off cannot move a transcript back, because a transcript split
 * between two writers is worse than one written by the older one.
 *
 * The router is also the only place that knows what a checkpoint's lifecycle means across the two regimes:
 *
 * - **prepare** — the journal prepares the checkpoint; the older writer only remembers it, and remembering is not writing;
 * - **commit** — the journal commits it; the older writer writes it *observationally*, so a failure there cannot roll back a
 *   durable checkpoint or fail the turn;
 * - **abort** — whoever was going to write is told to forget it;
 * - **skip** — a conversation already owned by the journal must be recovered before its checkpoint is skipped.
 *
 * Routes are cached per conversation, so two concurrent first writes cannot claim a conversation twice or split it.
 */
export type MirrorRoute = "journal" | "legacy";

/** The journal's side of a conversation: ownership, claim, and the three checkpoint moments. */
export interface JournalPort<Checkpoint, Store> {
  ownsConversation(conversationId: string): Promise<boolean>;
  claimConversation(conversationId: string): Promise<void>;
  recover(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<unknown>;
  prepareCheckpoint(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store, finalizeCheckpoint?: boolean): Promise<unknown>;
  commitCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  abortCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  skipCheckpoint(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<unknown>;
}

/** The writer that predates the journal: one call, and it does not care whether it worked. */
export interface LegacyMirrorPort<Checkpoint, Store> {
  write(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store, stateBlobId: Uint8Array): Promise<unknown>;
}

interface PendingLegacyCheckpoint<Checkpoint, Store> {
  readonly checkpoint: Checkpoint;
  readonly blobStore: Store;
}

export class MirrorRouter<Checkpoint, Store> {
  /** What the older writer was told to write, waiting for the commit that will actually write it. */
  readonly legacyPending = new Map<string, PendingLegacyCheckpoint<Checkpoint, Store>>();

  constructor(
    readonly journal: JournalPort<Checkpoint, Store>,
    readonly legacy: LegacyMirrorPort<Checkpoint, Store>,
    readonly isJournalEnabled: () => Promise<boolean>,
    readonly routes = new Map<string, Promise<MirrorRoute>>(),
  ) {}

  /** The route for a conversation, decided once: a claim that ran twice could split a transcript. */
  route(conversationId: string): Promise<MirrorRoute> {
    const selected = this.routes.get(conversationId);
    if (selected != null) return selected;
    const decided = this.chooseRoute(conversationId);
    this.routes.set(conversationId, decided);
    return decided;
  }

  /** The journal keeps what it already owns; a new conversation goes to it only while the journal is on, and is claimed. */
  private async chooseRoute(conversationId: string): Promise<MirrorRoute> {
    if (await this.journal.ownsConversation(conversationId)) return "journal";
    if (!(await this.isJournalEnabled())) return "legacy";
    await this.journal.claimConversation(conversationId);
    return "journal";
  }

  private async routesToJournal(conversationId: string): Promise<boolean> {
    return (await this.route(conversationId)) === "journal";
  }

  async recover(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<void> {
    if (!(await this.routesToJournal(conversationId))) return;
    await this.journal.recover(ctx, conversationId, checkpoint, blobStore);
  }

  async prepareCheckpoint(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store, finalizeCheckpoint = false, writeLegacyCheckpoint = finalizeCheckpoint): Promise<void> {
    if (await this.routesToJournal(conversationId)) {
      await this.journal.prepareCheckpoint(ctx, conversationId, checkpoint, blobStore, finalizeCheckpoint);
      return;
    }
    // Preparing is remembering: the older writer is only told about a checkpoint it will be asked to commit.
    if (writeLegacyCheckpoint) this.legacyPending.set(conversationId, { checkpoint, blobStore });
  }

  async commitCheckpoint(ctx: unknown, conversationId: string, stateBlobId: Uint8Array): Promise<void> {
    if (await this.routesToJournal(conversationId)) {
      await this.journal.commitCheckpoint(ctx, conversationId);
      return;
    }
    const pending = this.legacyPending.get(conversationId);
    if (pending == null) return;
    this.legacyPending.delete(conversationId);
    await bestEffortLegacyWrite(() => this.legacy.write(ctx, conversationId, pending.checkpoint, pending.blobStore, stateBlobId));
  }

  async abortCheckpoint(ctx: unknown, conversationId: string): Promise<void> {
    if (await this.routesToJournal(conversationId)) {
      await this.journal.abortCheckpoint(ctx, conversationId);
      return;
    }
    this.legacyPending.delete(conversationId);
  }

  /**
   * A skipped checkpoint: the journal skips it, and a conversation the journal owns but this router has not routed yet is
   * recovered first — the skip would otherwise be the first thing the journal heard about a conversation it lost.
   */
  async skipCheckpoint(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<void> {
    let selected = this.routes.get(conversationId);
    let recoverBeforeSkipping = false;
    if (selected == null) {
      if (!(await this.journal.ownsConversation(conversationId))) {
        this.legacyPending.delete(conversationId);
        return;
      }
      recoverBeforeSkipping = true;
      selected = Promise.resolve("journal");
      this.routes.set(conversationId, selected);
    }
    if ((await selected) !== "journal") {
      this.legacyPending.delete(conversationId);
      return;
    }
    if (recoverBeforeSkipping) await this.journal.recover(ctx, conversationId, checkpoint, blobStore);
    await this.journal.skipCheckpoint(ctx, conversationId, checkpoint, blobStore);
  }
}

/** The older writer is observational: a failure there must not roll back a durable checkpoint or fail the turn. */
async function bestEffortLegacyWrite(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch {
    // Deliberately ignored: the durable checkpoint is the platform's, the mirror is a convenience.
  }
}

// Compatibility names used by earlier recovered modules.
export type TranscriptMirrorPort<Checkpoint, Store> = JournalPort<Checkpoint, Store>;
export type LegacyTranscriptMirrorPort<Checkpoint, Store> = LegacyMirrorPort<Checkpoint, Store>;
export type TranscriptMirrorRoute = MirrorRoute;
