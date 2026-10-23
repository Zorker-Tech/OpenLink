/**
 * An agent's database.
 *
 * It is opened once per agent, created if it is not there, and read through the statements the session store gave it —
 * so the store's schema and the host's reads cannot drift apart.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mainTranscriptOf } from "../../../shared/transcript.ts";
import { replyCountByBranch, branchEntries } from "../../../shared/transcript-threads.ts";
import {
  EMPTY_SPEND_GUARD_STATE,
  EMPTY_UNREAD_STATE,
  EPISODE_PENDING_MAX,
  EPISODE_TURN_TEXT_CAP,
  REQUEST_ID_HISTORY_MAX,
  REQUEST_ID_PROMPT_MAX,
  parseAwaitingState,
  parseMemoryPromptSnapshot,
  parsePendingEpisodeTurns,
  parseProfile,
  parseRequestRecords,
  parseTranscriptEntry,
  parseUnreadState,
  resolveSpendGuardState,
  serializeSpendGuardState,
  type RequestRecord,
  type SpendGuardState
} from "./agent-db-serde.ts";
import { prepareStatements, type PreparedStatement } from "./agent-db-schema.ts";
import {
  openConfiguredDb,
  recoverCorruptStoreDb,
  type DbRecoveryOptions
} from "./agent-db-recovery.ts";
import {
  readTranscriptPage,
  readTranscriptTail,
  readTranscriptWindow,
  type TranscriptPageStatements
} from "./agent-db-transcript-pages.ts";
import {
  bumpDbWriteGeneration,
  liveDbHandleCount,
  registerLiveDbHandle,
  releaseLiveDbHandle,
} from "../../storage/store-db.ts";
import { isSqliteBusyError, isSqliteCorruptError } from "../../storage/sqlite-busy.ts";
import { publishTranscriptMutation } from "../../transcript/transcript-mutation-events.ts";
import {
  AgentMetadataSerde,
  getDefaultAgentMetadata,
  type AgentMetadata,
  type AgentMetadataKey,
} from "../../../packages/agent-kv/agent-conversation-store.ts";
import { fromHex, toHex } from "../../../packages/agent-kv/serde.ts";

export type { AgentMetadata, AgentMetadataKey };
export type TranscriptEntry = Record<string, unknown> & { id: string; kind: string };
export interface AwaitingUserResponse { tabId: string; reason: string; since: number }
export interface SlateProfile { description: string; avatarPath: string | null }
export interface AgentDbOptions extends DbRecoveryOptions {
  recoverOnCorruption?: boolean;
  onBusyError?(operationName: string, error: Error): void;
}

const KV = {
  metadata: "metadata", profile: "slateProfile", unread: "unreadState",
  awaiting: "awaitingUserResponse", requestIds: "requestIds", latestRequestId: "latestRequestId",
  episode: "episodePending", memorySnapshot: "memoryPromptSnapshot",
  profileSnapshot: "agentProfilePromptSnapshot", origin: "origin",
  introduction: "introductionPending", spendGuard: "automationSpendGuardState",
  spendGuardLegacy: "automationSpendGuardNudgedAt", partners: "conversationPartners",
  hiddenRepair: "hiddenEntryRepairVersion", staleRootCleanup: "staleRootCleanupVersion",
  purpose: "purpose", legacyBlobRetirement: "legacyStoreBlobRetirementVersion"
} as const;

const agentMetadataSerde = new AgentMetadataSerde();
export class SlateAgentDb {
  private db: DatabaseSync;
  private preparedStatements: Record<string, PreparedStatement>;
  private isClosed = false;
  private didRecover = false;
  private handleIsRegistered = false;
  private readonly keyListeners = new Map<AgentMetadataKey, Set<() => void>>();
  private readonly profileSubscribers = new Set<() => void>();
  private readonly awaitingSubscribers = new Set<() => void>();
  readonly agentDirName: string;
  readonly resolvedDbPath: string;

  constructor(readonly dbPath: string, readonly options: AgentDbOptions = {}) {
    this.agentDirName = basename(dirname(dbPath));
    this.resolvedDbPath = resolve(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const otherHandlesLive = liveDbHandleCount(this.resolvedDbPath) > 0;
    this.db = openConfiguredDb(dbPath, this.agentDirName, options, otherHandlesLive);
    this.preparedStatements = prepareStatements(this.db);
    registerLiveDbHandle(this.resolvedDbPath);
    this.handleIsRegistered = true;
    try {
      this.seedDefaultMetadataIfMissing();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private notify(subscribers: ReadonlySet<() => void>): void { queueMicrotask(() => { if (!this.isClosed) for (const subscriber of [...subscribers]) subscriber(); }); }
  private assertOpen(): void { if (this.isClosed) throw new Error("SlateAgentDb is closed"); }
  private runWrite(operationName: string, persistWrite: () => void): boolean {
    if (this.isClosed) return false;
    try {
      persistWrite();
      bumpDbWriteGeneration(this.resolvedDbPath);
      return true;
    }
    catch (error) {
      if (isSqliteBusyError(error)) {
        const busyError = error instanceof Error ? error : new Error(String(error));
        console.error(`[slate-agent-db] ${operationName} dropped on locked db (${this.agentDirName}):`, busyError);
        this.options.onBusyError?.(operationName, busyError);
        return false;
      }
      if ((this.options.recoverOnCorruption ?? true) && !this.didRecover && isSqliteCorruptError(error)) {
        console.error(`[slate-agent-db] ${operationName} hit corruption (${this.agentDirName}); recovering in place:`, error);
        if (this.recoverInPlace(error)) {
          try {
            persistWrite();
            bumpDbWriteGeneration(this.resolvedDbPath);
            return true;
          } catch (retryFailure) {
            if (isSqliteBusyError(retryFailure)) return false;
            throw retryFailure;
          }
        }
      }
      throw error;
    }
  }
  private recoverInPlace(recoveryCause: unknown): boolean {
    const liveHandleCount = liveDbHandleCount(this.resolvedDbPath) - (this.handleIsRegistered ? 1 : 0);
    if (liveHandleCount > 0) {
      console.error(`[slate-agent-db] deferring in-place recovery for ${this.agentDirName}: ${liveHandleCount} other live handle(s) hold this store open`);
      return false;
    }
    try {
      this.db.close();
      this.db = recoverCorruptStoreDb(this.dbPath, this.agentDirName, this.options, recoveryCause);
      this.preparedStatements = prepareStatements(this.db);
      this.seedDefaultMetadataIfMissing();
      this.didRecover = true;
      return true;
    } catch (error) {
      this.isClosed = true;
      if (this.handleIsRegistered) {
        this.handleIsRegistered = false;
        releaseLiveDbHandle(this.resolvedDbPath);
      }
      const errnoCode = typeof error === "object" && error != null && "code" in error
        ? error.code ?? "error"
        : "error";
      console.error(`[slate-agent-db] in-place recovery failed for ${this.agentDirName} (${String(errnoCode)})`);
      return false;
    }
  }
  close(options: { checkpoint?: boolean } = {}): void {
    if (this.handleIsRegistered) {
      this.handleIsRegistered = false;
      releaseLiveDbHandle(this.resolvedDbPath);
    }
    if (this.isClosed) return;
    this.isClosed = true;
    if (options.checkpoint) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch (error) {
        console.error(`[slate-agent-db] checkpoint-on-close failed for ${this.agentDirName}:`, error);
      }
    }
    this.db.close();
  }

  readKv(metadataKey: string): string | null { if (this.isClosed) return null; const storedRow = this.db.prepare("SELECT value FROM kv WHERE key=?").get(metadataKey) as { value?: unknown } | undefined; return typeof storedRow?.value === "string" ? storedRow.value : null; }
  writeKv(metadataKey: string, storedValue: string): boolean { return this.runWrite(`writeKv:${metadataKey}`, () => { this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(metadataKey, storedValue); }); }
  deleteKv(metadataKey: string): boolean { return this.runWrite(`deleteKv:${metadataKey}`, () => { this.db.prepare("DELETE FROM kv WHERE key=?").run(metadataKey); }); }
  private serializeMetadata(metadataValue: AgentMetadata): string { return toHex(agentMetadataSerde.serialize(metadataValue)); }
  private writeMetadata(metadataValue: AgentMetadata): boolean { return this.writeKv(KV.metadata, this.serializeMetadata(metadataValue)); }
  private seedDefaultMetadataIfMissing(): void { if (this.readKv(KV.metadata) == null) this.writeMetadata(getDefaultAgentMetadata(this.agentDirName)); }
  readMetadata(): AgentMetadata { const rawRecord = this.readKv(KV.metadata); return rawRecord == null ? getDefaultAgentMetadata(this.agentDirName) : agentMetadataSerde.deserialize(fromHex(rawRecord)); }
  get<K extends AgentMetadataKey>(metadataKey: K): AgentMetadata[K] { return this.readMetadata()[metadataKey]; }
  set<K extends AgentMetadataKey>(metadataKey: K, storedValue: AgentMetadata[K]): boolean {
    const metadataValue = this.readMetadata(), currentValue = metadataValue[metadataKey];
    if (metadataKey === "latestRootBlobId" ? toHex(currentValue as Uint8Array) === toHex(storedValue as Uint8Array) : currentValue === storedValue) return true;
    const didWrite = this.writeMetadata({ ...metadataValue, [metadataKey]: storedValue });
    if (didWrite) this.notify(this.keyListeners.get(metadataKey) ?? new Set());
    return didWrite;
  }
  compareAndSetLatestRootBlobId(request: { expectedRoot?: Uint8Array; nextRoot?: Uint8Array; expected?: Uint8Array; next?: Uint8Array }): boolean {
    const expectedRootBytes = request.expectedRoot ?? request.expected ?? new Uint8Array(), nextRootBytes = request.nextRoot ?? request.next ?? new Uint8Array();
    const rawRecord = this.readKv(KV.metadata); if (rawRecord == null) return false;
    const metadataValue = agentMetadataSerde.deserialize(fromHex(rawRecord)); if (toHex(metadataValue.latestRootBlobId) !== toHex(expectedRootBytes)) return false;
    let didChange = false; this.runWrite("compareAndSetLatestRootBlobId", () => { const updateResult = this.db.prepare("UPDATE kv SET value=? WHERE key=? AND value=?").run(this.serializeMetadata({ ...metadataValue, latestRootBlobId: nextRootBytes }), KV.metadata, rawRecord); didChange = Number(updateResult.changes) === 1; });
    if (didChange) this.notify(this.keyListeners.get("latestRootBlobId") ?? new Set()); return didChange;
  }
  subscribe(metadataKey: AgentMetadataKey, subscriber: () => void): () => void { const subscriberSet = this.keyListeners.get(metadataKey) ?? new Set(); subscriberSet.add(subscriber); this.keyListeners.set(metadataKey, subscriberSet); return () => subscriberSet.delete(subscriber); }

  getSlateProfile(): SlateProfile { return parseProfile(this.readKv(KV.profile)); }
  setSlateProfile(profile: SlateProfile): boolean { const currentValue = this.getSlateProfile(); if (currentValue.description === profile.description && currentValue.avatarPath === profile.avatarPath) return true; const didWrite = this.writeKv(KV.profile, JSON.stringify(profile)); if (didWrite) this.notify(this.profileSubscribers); return didWrite; }
  subscribeSlateProfile(subscriber: () => void): () => void { this.profileSubscribers.add(subscriber); return () => this.profileSubscribers.delete(subscriber); }
  getUnreadState() { return parseUnreadState(this.readKv(KV.unread)); }
  private writeUnreadState(state: ReturnType<typeof parseUnreadState>): boolean { return this.writeKv(KV.unread, JSON.stringify(state)); }
  markActivity(timestamp = Date.now()): void { const currentValue = this.getUnreadState(); if (currentValue.lastActivityAt < timestamp) this.writeUnreadState({ ...currentValue, lastActivityAt: timestamp, unreadCount: currentValue.unreadCount + 1 }); }
  markViewed(timestamp = Date.now(), options: { preserveManualUnread?: boolean } = {}): void { const currentValue = this.getUnreadState(); if (options.preserveManualUnread && currentValue.isManuallyUnread) return; if (currentValue.isManuallyUnread || currentValue.lastViewedAt < timestamp) this.writeUnreadState({ ...currentValue, lastViewedAt: timestamp, isManuallyUnread: false, unreadCount: 0 }); }
  markUnread(timestamp = Date.now()): void { const currentValue = this.getUnreadState(), lastActivityAt = currentValue.lastActivityAt || timestamp, newest = this.getNewestDividerAnchorTimestampMs(); const lastViewedAt = Math.min(currentValue.lastViewedAt, lastActivityAt - 1, timestamp - 1, newest > 0 ? newest - 1 : Infinity); this.writeUnreadState({ lastActivityAt, lastViewedAt, isManuallyUnread: true, unreadCount: Math.max(currentValue.unreadCount, 1) }); }
  markRead(timestamp = Date.now()): void { const currentValue = this.getUnreadState(); this.writeUnreadState({ ...currentValue, lastViewedAt: Math.max(currentValue.lastActivityAt, timestamp), isManuallyUnread: false, unreadCount: 0 }); }
  getAutomationSpendGuardState(): SpendGuardState { return resolveSpendGuardState({ state: this.readKv(KV.spendGuard), legacyNudgedAt: this.readKv(KV.spendGuardLegacy) }); }
  setAutomationSpendGuardState(state: SpendGuardState): void { const rawRecord = serializeSpendGuardState(state); if (rawRecord == null) this.deleteKv(KV.spendGuard); else this.writeKv(KV.spendGuard, rawRecord); this.deleteKv(KV.spendGuardLegacy); }

  getAwaitingUserResponse(): AwaitingUserResponse | null { return parseAwaitingState(this.readKv(KV.awaiting)); }
  setAwaitingUserResponse(state: AwaitingUserResponse | null): boolean { const currentValue = this.getAwaitingUserResponse(); if (JSON.stringify(currentValue) === JSON.stringify(state)) return false; const didWrite = state == null ? this.deleteKv(KV.awaiting) : this.writeKv(KV.awaiting, JSON.stringify(state)); if (didWrite) this.notify(this.awaitingSubscribers); return didWrite; }
  setAwaitingUserResponseForTab(tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): boolean { const currentValue = this.getAwaitingUserResponse(); if (currentValue != null && currentValue.tabId !== tabId) return false; if (state == null && (currentValue == null || (options?.ifSinceBefore != null && currentValue.since >= options.ifSinceBefore))) return false; if (state != null && state.tabId !== tabId) return false; return this.setAwaitingUserResponse(state); }
  subscribeAwaitingUserResponse(subscriber: () => void): () => void { this.awaitingSubscribers.add(subscriber); return () => this.awaitingSubscribers.delete(subscriber); }

  getRequestIds(): RequestRecord[] { const requestRecords = parseRequestRecords(this.readKv(KV.requestIds)); if (requestRecords.length) return requestRecords; const legacy = this.readKv(KV.latestRequestId)?.trim(); return legacy ? [{ id: legacy, at: 0 }] : []; }
  recordRequestId(id: string, timestamp = Date.now(), prompt?: string, source?: string): void { const requestText = id.trim(); if (!requestText) return; const requestRecords = this.getRequestIds(); if (requestRecords.at(-1)?.id === requestText) return; const promptLabel = prompt?.trim().slice(0, REQUEST_ID_PROMPT_MAX); const requestRecord: RequestRecord = { id: requestText, at: timestamp, ...(promptLabel ? { prompt: promptLabel } : {}), ...(source ? { source } : {}) }; this.writeKv(KV.requestIds, JSON.stringify([...requestRecords, requestRecord].slice(-REQUEST_ID_HISTORY_MAX))); }
  getAgentOrigin(): "dev" | "user" { return this.readKv(KV.origin) === "dev" ? "dev" : "user"; }
  setAgentOrigin(origin: "dev" | "user"): void { this.writeKv(KV.origin, origin); }
  getIntroductionPending(): boolean { return this.readKv(KV.introduction) === "1"; }
  setIntroductionPending(pendingFlag: boolean): void { if (pendingFlag) this.writeKv(KV.introduction, "1"); else this.deleteKv(KV.introduction); }
  private readVersion(metadataKey: string): number { const storedValue = Number.parseInt(this.readKv(metadataKey) ?? "", 10); return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : 0; }
  getHiddenEntryRepairVersion(): number { return this.readVersion(KV.hiddenRepair); }
  setHiddenEntryRepairVersion(versionNumber: number): boolean { return this.writeKv(KV.hiddenRepair, String(versionNumber)); }
  getStaleRootCleanupVersion(): number { return this.readVersion(KV.staleRootCleanup); }
  setStaleRootCleanupVersion(versionNumber: number): boolean { return this.writeKv(KV.staleRootCleanup, String(versionNumber)); }
  getConversationPartnerIds(): string[] { try { const parsed: unknown = JSON.parse(this.readKv(KV.partners) ?? "[]"); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []; } catch { return []; } }
  addConversationPartner(partnerId: string): void { const id = partnerId.trim(); if (!id || id === this.get("agentId")) return; const values = new Set(this.getConversationPartnerIds()); if (values.has(id)) return; values.add(id); this.writeKv(KV.partners, JSON.stringify([...values].sort())); }

  hasLegacyConversationBlobs(): boolean { if (this.isClosed) return false; return this.db.prepare("SELECT 1 present FROM blobs LIMIT 1").get() != null; }
  getTranscriptEntries(): TranscriptEntry[] { if (this.isClosed) return []; return (this.preparedStatements.listTranscriptEntries!.all() as Array<{ entry?: unknown }>).flatMap((storedRow) => typeof storedRow.entry === "string" ? (parseTranscriptEntry(storedRow.entry) as TranscriptEntry | null) ?? [] : []); }
  getNewestDividerAnchorTimestampMs(): number { if (this.isClosed) return 0; const storedValue = (this.preparedStatements.newestDividerAnchorTimestamp!.get() as { timestampMs?: unknown } | undefined)?.timestampMs; return typeof storedValue === "number" && Number.isFinite(storedValue) && storedValue > 0 ? storedValue : 0; }
  private transcriptPageStatements(): TranscriptPageStatements {
    return {
      listTranscriptPage: this.preparedStatements.listTranscriptPage as TranscriptPageStatements["listTranscriptPage"],
      listTranscriptWindow: this.preparedStatements.listTranscriptWindow as TranscriptPageStatements["listTranscriptWindow"],
      listTranscriptTail: this.preparedStatements.listTranscriptTail as TranscriptPageStatements["listTranscriptTail"]
    };
  }
  getTranscriptPage(pageQuery: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }) { return this.isClosed ? { entries: [] } : readTranscriptPage(this.transcriptPageStatements(), pageQuery); }
  getTranscriptWindow(pageQuery: { beforeSeq?: number; limit: number }) { return this.isClosed ? { entries: [] } : readTranscriptWindow(this.transcriptPageStatements(), pageQuery, entryList => this.threadCountsFor(entryList as TranscriptEntry[])); }
  getTranscriptTail(pageQuery: { beforeSeq?: number; limit: number }) { return this.isClosed ? { entries: [] } : readTranscriptTail(this.transcriptPageStatements(), pageQuery); }
  getThread(rootId: string) { if (this.isClosed) return { entries: [] }; const root = this.getEntryById(rootId); const descendants = branchEntries(rootId, this.getBranchedEntries()); return { entries: root == null ? descendants : [root, ...descendants] }; }
  getBranchedEntries(): TranscriptEntry[] { if (this.isClosed) return []; return (this.preparedStatements.listBranchedEntries!.all() as Array<{ entry?: unknown }>).flatMap((storedRow) => typeof storedRow.entry === "string" ? (parseTranscriptEntry(storedRow.entry) as TranscriptEntry | null) ?? [] : []); }
  threadCountsFor(entryList: readonly TranscriptEntry[]): Record<string, number> { const counts = replyCountByBranch(this.getBranchedEntries()); const updateResult: Record<string, number> = {}; for (const entry of entryList) { const count = counts.get(entry.id); if (count !== undefined) updateResult[entry.id] = count; } return updateResult; }
  getEntryById(id: string): TranscriptEntry | null { if (this.isClosed) return null; const storedRow = this.preparedStatements.getTranscriptEntry!.get(id) as { entry?: unknown } | undefined; return typeof storedRow?.entry === "string" ? parseTranscriptEntry(storedRow.entry) as TranscriptEntry | null : null; }
  appendTranscriptEntry(entry: TranscriptEntry): boolean { let inserted = false; const committed = this.runWrite("appendTranscriptEntry", () => { inserted = Number((this.preparedStatements.insertTranscriptEntry!.run(entry.id, JSON.stringify(entry)) as { changes?: unknown }).changes) > 0; }); if (committed && inserted) publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: [entry] }); return committed && inserted; }
  appendTranscriptEntries(entryList: readonly TranscriptEntry[]): boolean { if (!entryList.length) return true; const inserted: TranscriptEntry[] = []; const committed = this.runWrite("appendTranscriptEntries", () => { this.db.exec("BEGIN IMMEDIATE"); try { for (const entry of entryList) if (Number((this.preparedStatements.insertTranscriptEntry!.run(entry.id, JSON.stringify(entry)) as { changes?: unknown }).changes) > 0) inserted.push(entry); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); if (committed && inserted.length) publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: inserted }); return committed; }
  updateTranscriptEntry(id: string, update: (entry: TranscriptEntry) => TranscriptEntry): TranscriptEntry | null { const currentValue = this.getEntryById(id); if (currentValue == null) return null; const nextRootBytes = update(currentValue); const committed = this.runWrite("updateTranscriptEntry", () => { this.preparedStatements.updateTranscriptEntry!.run(JSON.stringify(nextRootBytes), id); }); if (!committed) return null; publishTranscriptMutation({ kind: "entries-upserted", agentId: this.agentDirName, entries: [nextRootBytes] }); return nextRootBytes; }
  deleteTranscriptEntry(id: string): boolean { const committed = this.runWrite("deleteTranscriptEntry", () => { this.preparedStatements.deleteTranscriptEntry!.run(id); }); if (committed) publishTranscriptMutation({ kind: "entry-deleted", agentId: this.agentDirName, entryId: id }); return committed; }

  getPendingEpisodeTurns() { return parsePendingEpisodeTurns(this.readKv(KV.episode)); }
  recordEpisodeTurn(episodeTurn: { ts: number; user: string; agent: string }): void { const capped = { ts: episodeTurn.ts, user: episodeTurn.user.slice(0, EPISODE_TURN_TEXT_CAP), agent: episodeTurn.agent.slice(0, EPISODE_TURN_TEXT_CAP) }; this.writeKv(KV.episode, JSON.stringify([...this.getPendingEpisodeTurns(), capped].slice(-EPISODE_PENDING_MAX))); }
  clearPendingEpisodeTurns(): void { this.deleteKv(KV.episode); }
  getMemoryPromptSnapshot() { return parseMemoryPromptSnapshot(this.readKv(KV.memorySnapshot)); }
  setMemoryPromptSnapshot(snapshot: unknown): void { this.writeKv(KV.memorySnapshot, JSON.stringify(snapshot)); }
  clearMemoryPromptSnapshot(): void { this.deleteKv(KV.memorySnapshot); }
  getAgentProfilePromptSnapshot(): unknown { try { return JSON.parse(this.readKv(KV.profileSnapshot) ?? "null") as unknown; } catch { return null; } }
  setAgentProfilePromptSnapshot(snapshot: unknown): void { this.writeKv(KV.profileSnapshot, JSON.stringify(snapshot)); }
  clearAgentProfilePromptSnapshot(): void { this.deleteKv(KV.profileSnapshot); }
  clearTransientState(): void { for (const metadataKey of [KV.unread, KV.spendGuardLegacy, KV.spendGuard, KV.awaiting, KV.latestRequestId, KV.requestIds, KV.episode, KV.memorySnapshot, KV.profileSnapshot]) this.deleteKv(metadataKey); }
  clearConversation(): boolean { if (this.isClosed) return false; const metadataValue = this.readMetadata(); const committed = this.runWrite("clearConversation", () => { this.db.exec("BEGIN IMMEDIATE"); try { this.preparedStatements.clearBlobs!.run(); this.preparedStatements.clearTranscriptEntries!.run(); for (const metadataKey of [KV.awaiting, KV.latestRequestId, KV.requestIds, KV.episode, KV.memorySnapshot, KV.profileSnapshot]) this.preparedStatements.deleteKv!.run(metadataKey); this.preparedStatements.setKv!.run(KV.metadata, this.serializeMetadata({ ...metadataValue, latestRootBlobId: new Uint8Array(), currentPlanUri: "" })); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); if (!committed) return false; publishTranscriptMutation({ kind: "conversation-cleared", agentId: this.agentDirName }); this.notify(this.awaitingSubscribers); this.notify(this.keyListeners.get("latestRootBlobId") ?? new Set()); return true; }
  getAgentPurpose(): string | null { const storedValue = this.readKv(KV.purpose); return storedValue && /^[a-z][a-z0-9_-]*$/.test(storedValue) ? storedValue : null; }
  setAgentPurpose(purpose: string): void { this.writeKv(KV.purpose, purpose); }
  clearAgentPurpose(): void { this.deleteKv(KV.purpose); }
  getLegacyBlobRetirementVersion(): number { return this.readVersion(KV.legacyBlobRetirement); }
  retireLegacyConversationBlobs(versionNumber: number): boolean { if (this.isClosed) return false; return this.runWrite("retireLegacyConversationBlobs", () => { this.db.exec("BEGIN IMMEDIATE"); try { this.db.exec("DELETE FROM blobs"); this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KV.legacyBlobRetirement, String(versionNumber)); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; } }); }
  mainTranscriptOf(): readonly TranscriptEntry[] { return mainTranscriptOf(this.getTranscriptEntries()) as readonly TranscriptEntry[]; }
}
