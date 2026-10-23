/** The live sessions a host keeps, and what it does to the transcript of each.

 * A conversation is opened for a conversation, its transcript is read, appended to and cleared, its window is written into the
 * store so a reader sees the newest entryList, and a conversation whose subject is gone is reported as such. */
import { dirname } from "node:path";

import { isSlateAgentLimitError } from "../../shared/agents/agents.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import type {
  TranscriptEntry,
  TranscriptManagerLike,
} from "./transcript-hub.ts";
import {
  appendEntry as appendTranscriptEntry,
  clearTranscript,
  getTranscript,
  setTranscript,
} from "./transcript-store.ts";

export class AgentGoneError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} no longer exists`);
    this.name = "AgentGoneError";
  }
}

export interface TranscriptWindow {
  readonly entries: TranscriptEntry[];
  readonly [key: string]: unknown;
}

export interface LiveTranscriptSession {
  readonly id: string;
  readonly dbPath: string;
  readonly db: Record<string, any>;
  readonly agentStore?: { dispose(): void | Promise<void> };
  readonly automations?: { listDefinitions(): readonly unknown[] };
  readonly [key: string]: unknown;
}

export interface AppendEntryOptions {
  readonly persistBeforeEmit?: boolean;
  readonly deferEmit?: boolean;
  readonly onPersistOutcome?: (isDurable: boolean) => void;
}

function raisesUserActivity(transcriptEntry: TranscriptEntry): boolean {
  return transcriptEntry.fromAgent == null;
}

export class SessionRuntime {
  activeSession: LiveTranscriptSession | undefined;
  loaded = false;
  isWindowFocused = false;
  windowFocusedAtMs: number | null = null;
  inMemoryTranscriptAgentId: string | null = null;
  readonly liveSessions = new Map<string, LiveTranscriptSession>();
  readonly pendingSessionOpens = new Map<
    string,
    Promise<LiveTranscriptSession>
  >();
  readonly deletedAgentIds = new Set<string>();
  windowedActivationTail: Promise<void> = Promise.resolve();
  windowedActivationAbort: AbortController | null = null;
  pendingActivationAgentId: string | null = null;

  constructor(readonly tm: TranscriptManagerLike) {}

  async settledOpen(
    inflight: Promise<LiveTranscriptSession> | undefined,
  ): Promise<LiveTranscriptSession | undefined> {
    if (inflight == null) return undefined;
    const [settled] = await Promise.allSettled([inflight]);
    return settled?.status === "fulfilled" ? settled.value : undefined;
  }

  invalidateDeferredActivation(): void {
    this.windowedActivationAbort?.abort();
    this.windowedActivationAbort = null;
    this.pendingActivationAgentId = null;
  }

  clearPendingActivationClaim(owner: AbortController): void {
    if (this.windowedActivationAbort === owner)
      this.pendingActivationAgentId = null;
  }

  getActiveAgentDir(): string | undefined {
    return this.activeSession == null
      ? undefined
      : dirname(this.activeSession.dbPath);
  }

  async ensureLoaded(): Promise<TranscriptEntry[]> {
    const conversation = await this.ensureSession();
    if (!this.loaded) {
      const entryList = (await this.tm.sessionStore.getTranscriptEntries(
        conversation,
      )) as TranscriptEntry[];
      this.setActiveTranscript(conversation.id, entryList);
      this.loaded = true;
      this.tm.roster.emit({
        type: "snapshot",
        activeAgentId: conversation.id,
        entries: entryList,
      });
      return entryList;
    }
    return getTranscript();
  }

  getEntries(): TranscriptEntry[] {
    return getTranscript();
  }

  appendEntry(
    transcriptEntry: TranscriptEntry,
    appendOptions?: AppendEntryOptions,
  ): TranscriptEntry {
    appendTranscriptEntry(transcriptEntry);
    if (appendOptions?.persistBeforeEmit === true) {
      const isDurable =
        this.activeSession?.db.appendTranscriptEntry(transcriptEntry) ?? false;
      try {
        appendOptions.onPersistOutcome?.(Boolean(isDurable));
      } catch {}
      if (appendOptions.deferEmit !== true)
        this.tm.roster.emit({ type: "appended", entry: transcriptEntry });
    } else {
      this.tm.roster.emit({ type: "appended", entry: transcriptEntry });
      this.activeSession?.db.appendTranscriptEntry(transcriptEntry);
    }
    if (
      ["send-message", "message", "user-attachment"].includes(transcriptEntry.kind) &&
      raisesUserActivity(transcriptEntry) &&
      this.activeSession != null
    ) {
      this.markActiveSessionArrival(this.activeSession);
    }
    return transcriptEntry;
  }

  markActiveSessionArrival(conversation: LiveTranscriptSession): void {
    const now = Date.now();
    this.tm.sessionStore.markSessionActivity(conversation, now);
    if (this.isWindowFocused) {
      this.tm.sessionStore.markSessionViewedNow(conversation, now, {
        preserveManualUnread: true,
      });
    } else {
      void this.tm.roster.emitAgentUpdate(conversation.id);
    }
  }

  async setWindowFocused(isFocused: boolean): Promise<void> {
    const wasFocused = this.isWindowFocused;
    this.isWindowFocused = isFocused;
    this.windowFocusedAtMs = isFocused ? Date.now() : null;
    if (!isFocused || wasFocused || this.activeSession == null) return;
    const active = this.activeSession;
    const unreadState = active.db.getUnreadState() as {
      isManuallyUnread: boolean;
      lastActivityAt: number;
      lastViewedAt: number;
    };
    if (unreadState.isManuallyUnread || unreadState.lastActivityAt <= unreadState.lastViewedAt)
      return;
    await this.tm.sessionStore.markSessionViewed(active, Date.now(), {
      preserveManualUnread: true,
    });
    void this.tm.roster.emitAgentUpdate(active.id);
  }

  setActiveTranscript(
    agentId: string,
    entryList: readonly TranscriptEntry[],
  ): void {
    setTranscript(entryList);
    this.inMemoryTranscriptAgentId = agentId;
  }

  clearActiveTranscript(agentId: string | null): void {
    clearTranscript();
    this.inMemoryTranscriptAgentId = agentId;
  }

  getActiveAgentId(): string | null {
    return this.activeSession?.id ?? null;
  }
  getAnnouncedActiveAgentId(): string | null {
    return this.pendingActivationAgentId ?? this.getActiveAgentId();
  }
  getWindowFocusedAtMs(): number | null {
    return this.windowFocusedAtMs;
  }

  noteDesktopContact(): void {
    if (this.isWindowFocused) this.windowFocusedAtMs = Date.now();
  }

  async switchAgent(agentId: string): Promise<TranscriptEntry[]> {
    const previousSession = this.activeSession;
    if (previousSession?.id === agentId) {
      this.invalidateDeferredActivation();
      return getTranscript();
    }
    this.invalidateDeferredActivation();
    const opened = await this.activateSession(agentId, previousSession);
    if (opened == null) return getTranscript();
    this.tm.roster.emit({
      type: "snapshot",
      activeAgentId: opened.session.id,
      entries: opened.entries,
    });
    await this.announceActivation(opened.session, previousSession);
    return opened.entries;
  }

  async activateSession(
    agentId: string,
    previousSession?: LiveTranscriptSession,
    superseded?: () => boolean,
  ): Promise<
    { session: LiveTranscriptSession; entries: TranscriptEntry[] } | undefined
  > {
    const incomingSession =
      this.liveSessions.get(agentId) ?? (await this.openSessionOnce(agentId));
    if (superseded?.() === true) return undefined;
    const now = Date.now();
    await this.markSessionLeftBehind(previousSession, now);
    await this.tm.sessionStore.markSessionViewed(incomingSession, now);
    const entryList = incomingSession.db.getTranscriptEntries() as TranscriptEntry[];
    if (superseded?.() === true) return undefined;
    this.setActiveTranscript(incomingSession.id, entryList);
    this.loaded = true;
    await this.replaceSession(incomingSession);
    return { session: incomingSession, entries: entryList };
  }

  async markSessionLeftBehind(
    previousSession: LiveTranscriptSession | undefined,
    now: number,
  ): Promise<void> {
    if (previousSession == null || !this.isWindowFocused) return;
    await this.tm.sessionStore.markSessionViewed(previousSession, now, {
      preserveManualUnread: true,
    });
  }

  async announceActivation(
    conversation: LiveTranscriptSession,
    previousSession?: LiveTranscriptSession,
  ): Promise<void> {
    await this.tm.roster.emitAgentUpdate(conversation.id);
    if (previousSession != null && previousSession.id !== conversation.id)
      await this.tm.roster.emitAgentUpdate(previousSession.id);
  }

  async openAgentWindowed(
    agentId: string,
    limit: number,
  ): Promise<TranscriptWindow> {
    return this.openAgentBounded(
      agentId,
      (db) => db.getTranscriptWindow({ limit }) as TranscriptWindow,
      () => this.getAgentTranscriptWindow(agentId, { limit }),
    );
  }

  async openAgentTail(
    agentId: string,
    limit: number,
  ): Promise<TranscriptWindow> {
    return this.openAgentBounded(
      agentId,
      (db) => db.getTranscriptTail({ limit }) as TranscriptWindow,
      () => this.getAgentTranscriptTail(agentId, { limit }),
    );
  }

  async openAgentBounded(
    agentId: string,
    readLive: (db: Record<string, any>) => TranscriptWindow,
    readCold: () => TranscriptWindow,
  ): Promise<TranscriptWindow> {
    const live = this.liveSessions.get(agentId);
    if (this.activeSession?.id === agentId && live != null) {
      this.invalidateDeferredActivation();
      return readLive(live.db);
    }
    if (live != null) {
      this.invalidateDeferredActivation();
      const previousSession = this.activeSession;
      const opened = await this.activateSession(agentId, previousSession);
      if (opened == null) return readLive(live.db);
      await this.announceActivation(opened.session, previousSession);
      return readLive(opened.session.db);
    }
    const reply = readCold();
    this.tm.sessionStore.markAgentViewed(agentId);
    void this.tm.roster.emitAgentUpdate(agentId);
    this.scheduleWindowedActivation(agentId, reply.entries.at(-1)?.id);
    return reply;
  }

  scheduleWindowedActivation(agentId: string, lastShippedId?: string): void {
    this.invalidateDeferredActivation();
    const activationAbort = new AbortController();
    this.windowedActivationAbort = activationAbort;
    this.pendingActivationAgentId = agentId;
    const superseded = () =>
      activationAbort.signal.aborted || this.tm.disposed === true;
    this.windowedActivationTail = this.windowedActivationTail
      .then(async () => {
        await this.tm.taskBoundary.settled();
        if (superseded()) return this.clearPendingActivationClaim(activationAbort);
        const previousSession = this.activeSession;
        const opened = await this.activateSession(
          agentId,
          previousSession,
          superseded,
        );
        this.clearPendingActivationClaim(activationAbort);
        if (opened == null) return;
        this.emitWindowedCatchUp(lastShippedId, opened.entries);
        await this.announceActivation(opened.session, previousSession);
      })
      .catch((error: unknown) => {
        this.clearPendingActivationClaim(activationAbort);
        console.error(
          `[slate] windowed background activation failed for ${agentId}:`,
          error,
        );
      });
  }

  emitWindowedCatchUp(
    lastShippedId: string | undefined,
    entryList: readonly TranscriptEntry[],
  ): void {
    const from =
      lastShippedId == null
        ? 0
        : entryList.findIndex((transcriptEntry) => transcriptEntry.id === lastShippedId) + 1;
    if (lastShippedId != null && from === 0) return;
    for (let index = from; index < entryList.length; index += 1) {
      const transcriptEntry = entryList[index];
      if (transcriptEntry != null) this.tm.roster.emit({ type: "appended", entry: transcriptEntry });
    }
  }

  getAgentTranscriptWindow(agentId: string, query: unknown): TranscriptWindow {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptWindow(query) ??
      this.tm.sessionStore.readAgentTranscriptWindow(agentId, query)
    );
  }

  getAgentTranscriptTail(agentId: string, query: unknown): TranscriptWindow {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptTail(query) ??
      this.tm.sessionStore.readAgentTranscriptTail(agentId, query)
    );
  }

  getAgentThread(agentId: string, rootId: string): unknown {
    return (
      this.liveSessions.get(agentId)?.db.getThread(rootId) ??
      this.tm.sessionStore.readAgentThread(agentId, rootId)
    );
  }

  async ensureActionTarget(agentId?: string): Promise<void> {
    if (agentId == null || this.activeSession?.id === agentId) return;
    await this.tm.switchAgent(agentId);
  }

  async getAgentTranscript(agentId: string): Promise<TranscriptEntry[]> {
    if (
      this.activeSession?.id === agentId &&
      this.inMemoryTranscriptAgentId === agentId
    )
      return getTranscript();
    return this.tm.sessionStore.getAgentTranscriptEntries(agentId);
  }

  getAgentTranscriptPage(agentId: string, query: unknown): unknown {
    return (
      this.liveSessions.get(agentId)?.db.getTranscriptPage(query) ??
      this.tm.sessionStore.readAgentTranscriptPage(agentId, query)
    );
  }

  async resolveBackgroundSession(
    agentId: string,
  ): Promise<LiveTranscriptSession> {
    if (this.isAgentGone(agentId)) throw new AgentGoneError(agentId);
    return (
      this.liveSessions.get(agentId) ?? (await this.openSessionOnce(agentId))
    );
  }

  openSessionOnce(agentId: string): Promise<LiveTranscriptSession> {
    const inflight = this.pendingSessionOpens.get(agentId);
    if (inflight != null) return inflight;
    const opened = this.tm.sessionStore.openSession(
      agentId,
    ) as Promise<LiveTranscriptSession>;
    this.pendingSessionOpens.set(agentId, opened);
    void opened.catch(() => {
      if (this.pendingSessionOpens.get(agentId) === opened)
        this.pendingSessionOpens.delete(agentId);
    });
    return opened;
  }

  async tryEnsureSession(): Promise<LiveTranscriptSession | null> {
    try {
      return await this.ensureSession();
    } catch (error) {
      if (isSlateAgentLimitError(error)) return null;
      throw error;
    }
  }

  async ensureSession(): Promise<LiveTranscriptSession> {
    if (this.activeSession != null) return this.activeSession;
    const subjects = (await this.tm.sessionStore.listAgents()) as Array<{
      id: string;
    }>;
    const recordIds =
      (await this.tm.sessionStore.listAgentRecordIds()) as string[];
    const persistedId = this.tm.sessionStore.readActiveAgentId() as
      string | null;
    const restorable =
      persistedId != null &&
      (subjects.some((subject) => subject.id === persistedId) ||
        recordIds.includes(persistedId));
    const orderedIds = [
      ...new Set([
        ...(restorable && persistedId != null ? [persistedId] : []),
        ...subjects.map((subject) => subject.id),
        ...recordIds,
      ]),
    ];
    let conversation: LiveTranscriptSession | null = null;
    for (const id of orderedIds) {
      try {
        conversation = await this.openSessionOnce(id);
        break;
      } catch (error) {
        console.error(
          `[slate] skipping unopenable agent ${id} on boot: ${errorLogTag(error)}`,
        );
      }
    }
    const resolvedSession =
      conversation ??
      ((await this.tm.sessionStore.createFallbackSession((id: string) =>
        this.openSessionOnce(id),
      )) as LiveTranscriptSession);
    this.setActiveSession(resolvedSession);
    await this.tm.sessionStore.markSessionViewed(resolvedSession);
    this.tm.runLifecycle.watchActiveSession(resolvedSession);
    return resolvedSession;
  }

  setActiveSession(conversation: LiveTranscriptSession): void {
    const priorSession = this.activeSession;
    if (priorSession != null && priorSession.id !== conversation.id) {
      void this.tm.automationRuntime.enqueueAutomationLifecycleMutation({
        agentId: priorSession.id,
        mutation: () => {
          if (
            this.deletedAgentIds.has(priorSession.id) ||
            !this.tm.sessionStore.agentExists(priorSession.id)
          ) {
            this.tm.automationRuntime.lastKnownAutomations.delete(priorSession.id);
            return;
          }
          const previousSession = priorSession.automations?.listDefinitions() ?? [];
          this.tm.automationRuntime.recordInactiveAutomationChanges({
            agentId: priorSession.id,
            before: previousSession,
            after: previousSession,
            source: "agent",
          });
        },
      });
    }
    if (priorSession?.id !== conversation.id) this.tm.roster.invalidateActiveOutline();
    this.activeSession = conversation;
    this.liveSessions.set(conversation.id, conversation);
    this.tm.sessionStore.writeActiveAgentId(conversation.id);
  }

  isAgentGone(agentId: string): boolean {
    return (
      this.deletedAgentIds.has(agentId) ||
      !this.tm.sessionStore.agentExists(agentId)
    );
  }

  async replaceSession(conversation: LiveTranscriptSession): Promise<void> {
    const priorSession = this.activeSession;
    this.setActiveSession(conversation);
    this.tm.runLifecycle.watchActiveSession(conversation);
    await this.tm.runLifecycle.retireSession(priorSession);
  }
}
