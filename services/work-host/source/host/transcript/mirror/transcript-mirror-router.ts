export type MirrorRoute = "journal" | "legacy"

export interface JournalPort<Checkpoint, Store> {
  ownsConversation(conversationId: string): Promise<boolean>
  claimConversation(conversationId: string): Promise<void>
  recover(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<unknown>
  prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint?: boolean,
  ): Promise<unknown>
  commitCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>
  abortCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>
  skipCheckpoint(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<unknown>
}

export interface LegacyMirrorPort<Checkpoint, Store> {
  write(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    stateBlobId: Uint8Array,
  ): Promise<unknown>
}

interface PendingLegacyCheckpoint<Checkpoint, Store> {
  readonly checkpoint: Checkpoint
  readonly blobStore: Store
}

type RouteDecision = Promise<MirrorRoute>

export class MirrorRouter<Checkpoint, Store> {
  readonly legacyPending = new Map<string, PendingLegacyCheckpoint<Checkpoint, Store>>()

  constructor(
    readonly journal: JournalPort<Checkpoint, Store>,
    readonly legacy: LegacyMirrorPort<Checkpoint, Store>,
    readonly isJournalEnabled: () => Promise<boolean>,
    readonly routes = new Map<string, RouteDecision>(),
  ) {}

  route(conversationId: string): RouteDecision {
    const known = this.routes.get(conversationId)
    if (known !== undefined) return known

    const decision = this.decideRoute(conversationId)
    this.routes.set(conversationId, decision)
    void decision.catch(() => {
      if (this.routes.get(conversationId) === decision) this.routes.delete(conversationId)
    })
    return decision
  }

  private async decideRoute(conversationId: string): Promise<MirrorRoute> {
    if (await this.journal.ownsConversation(conversationId)) return "journal"
    if (!(await this.isJournalEnabled())) return "legacy"
    await this.journal.claimConversation(conversationId)
    return "journal"
  }

  private async isJournalConversation(conversationId: string): Promise<boolean> {
    return await this.route(conversationId) === "journal"
  }

  async recover(ctx: unknown, conversationId: string, checkpoint: Checkpoint, blobStore: Store): Promise<void> {
    if (await this.isJournalConversation(conversationId)) {
      await this.journal.recover(ctx, conversationId, checkpoint, blobStore)
    }
  }

  async prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint = false,
    writeLegacyCheckpoint = finalizeCheckpoint,
  ): Promise<void> {
    if (await this.isJournalConversation(conversationId)) {
      await this.journal.prepareCheckpoint(
        ctx,
        conversationId,
        checkpoint,
        blobStore,
        finalizeCheckpoint,
      )
      return
    }
    if (writeLegacyCheckpoint) {
      this.legacyPending.set(conversationId, { checkpoint, blobStore })
    }
  }

  async commitCheckpoint(ctx: unknown, conversationId: string, stateBlobId: Uint8Array): Promise<void> {
    if (await this.isJournalConversation(conversationId)) {
      await this.journal.commitCheckpoint(ctx, conversationId)
      return
    }

    const pending = this.legacyPending.get(conversationId)
    if (pending === undefined) return
    this.legacyPending.delete(conversationId)
    await writeLegacyWithoutFailingTheTurn(() =>
      this.legacy.write(ctx, conversationId, pending.checkpoint, pending.blobStore, stateBlobId)
    )
  }

  async abortCheckpoint(ctx: unknown, conversationId: string): Promise<void> {
    if (await this.isJournalConversation(conversationId)) {
      await this.journal.abortCheckpoint(ctx, conversationId)
    } else {
      this.legacyPending.delete(conversationId)
    }
  }

  async skipCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
  ): Promise<void> {
    const existing = this.routes.get(conversationId)
    if (existing === undefined) {
      if (!(await this.journal.ownsConversation(conversationId))) {
        this.legacyPending.delete(conversationId)
        return
      }
      this.routes.set(conversationId, Promise.resolve<MirrorRoute>("journal"))
      await this.journal.recover(ctx, conversationId, checkpoint, blobStore)
      await this.journal.skipCheckpoint(ctx, conversationId, checkpoint, blobStore)
      return
    }

    if (await existing === "legacy") {
      this.legacyPending.delete(conversationId)
      return
    }
    await this.journal.skipCheckpoint(ctx, conversationId, checkpoint, blobStore)
  }
}

async function writeLegacyWithoutFailingTheTurn(write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch {
    // The durable checkpoint owns correctness; the legacy transcript is an observational mirror.
  }
}

export type TranscriptMirrorPort<Checkpoint, Store> = JournalPort<Checkpoint, Store>
export type LegacyTranscriptMirrorPort<Checkpoint, Store> = LegacyMirrorPort<Checkpoint, Store>
export type TranscriptMirrorRoute = MirrorRoute
