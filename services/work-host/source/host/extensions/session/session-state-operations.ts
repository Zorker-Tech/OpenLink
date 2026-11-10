import type { SlateAgentDb, AwaitingUserResponse } from "./agent-db.ts"
import type { OpenAgentSession } from "./agent-session.ts"
import { ensureConversationCapacityForTurn } from "./conversation-size-limits.ts"
import {
  expirePendingAutoReviewApprovalEntries,
  expirePendingLocalToolPermissionAskEntries,
} from "./pending-card-sweeps.ts"
import { getSlateSettingsPath, writeAgentSettings } from "../../agents/settings-file.ts"

type ViewedOptions = { readonly preserveManualUnread?: boolean }

export class SessionStateOperations {
  constructor(
    private readonly agentDir: (agentId: string) => string,
    private readonly withDb: <T>(
      agentId: string,
      operation: (db: SlateAgentDb, dbPath: string) => T | Promise<T>,
    ) => Promise<T>,
    private readonly seedActivity: (session: OpenAgentSession) => Promise<void>,
    private readonly workerPool: () => import("./agent-session.ts").MaterializationPort["requireWorkerPool"],
  ) {}

  async markViewed(
    session: OpenAgentSession,
    at: number,
    options: ViewedOptions,
  ): Promise<void> {
    await this.seedActivity(session)
    session.db.markViewed(at, options)
  }

  markViewedNow(session: OpenAgentSession, at: number, options: ViewedOptions): void {
    session.db.markViewed(at, options)
  }

  markActivity(session: OpenAgentSession, at: number): void {
    session.db.markActivity(at)
  }

  async markAgentViewed(agentId: string, at: number, options: ViewedOptions): Promise<void> {
    try {
      await this.withDb(agentId, db => db.markViewed(at, options))
    } catch {
      // Best-effort background view update.
    }
  }

  async setUnread(agentId: string, unread: boolean, at: number): Promise<void> {
    await this.withDb(agentId, db => unread ? db.markUnread(at) : db.markRead(at))
  }

  setNotifyOnUpdates(agentId: string, enabled: boolean): void {
    this.#writeSettings(agentId, { notifyOnAgentUpdates: enabled })
  }

  setHiddenFromSidebar(agentId: string, hidden: boolean): void {
    this.#writeSettings(agentId, { hiddenFromSidebar: hidden })
  }

  async setAwaitingResponse(agentId: string, state: AwaitingUserResponse | null): Promise<void> {
    await this.withDb(agentId, db => db.setAwaitingUserResponse(state))
  }

  async setAwaitingResponseForTab(
    agentId: string,
    tabId: string,
    state: AwaitingUserResponse | null,
    options?: { ifSinceBefore?: number },
  ): Promise<boolean> {
    return this.withDb(agentId, db => db.setAwaitingUserResponseForTab(tabId, state, options))
  }

  async expireApprovals(agentId: string, onlyRequestId?: string): Promise<string[]> {
    return this.withDb(agentId, db =>
      expirePendingAutoReviewApprovalEntries(db as never, onlyRequestId)
    )
  }

  async expirePermissionAsks(args: {
    agentId: string
    onlyRequestId?: string
    ifPendingBeforeMs?: number
  }): Promise<string[]> {
    return this.withDb(args.agentId, db =>
      expirePendingLocalToolPermissionAskEntries(db as never, {
        ...(args.onlyRequestId === undefined ? {} : { onlyRequestId: args.onlyRequestId }),
        ...(args.ifPendingBeforeMs === undefined ? {} : { ifPendingBeforeMs: args.ifPendingBeforeMs }),
      })
    )
  }

  async clearMemoryPromptSnapshot(agentId: string): Promise<void> {
    await this.withDb(agentId, db => db.clearMemoryPromptSnapshot())
  }

  async ensureConversationCapacity(session: OpenAgentSession): Promise<void> {
    const requireWorkerPool = this.workerPool()
    if (requireWorkerPool === undefined) return
    await ensureConversationCapacityForTurn(
      { requireWorkerPool: () => requireWorkerPool() as never },
      session.dbPath,
      session.db,
    )
  }

  #writeSettings(
    agentId: string,
    value: { notifyOnAgentUpdates?: boolean; hiddenFromSidebar?: boolean },
  ): void {
    writeAgentSettings(getSlateSettingsPath(this.agentDir(agentId)), value)
  }
}
