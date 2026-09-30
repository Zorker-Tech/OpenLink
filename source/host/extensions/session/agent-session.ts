/**
 * A session, as the host holds it.
 *
 * The session owns its database, its transcript and the state it derives from both; what it exposes is the operations
 * the host performs on a session rather than the pieces it is built from.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile, type SlateAgentProfile } from "../../agents/agent-profile.ts";
import { getSlateSettingsPath, writeSlateSettingsFile } from "../../agents/settings-file.ts";
import { AUTOMATION_UI_LIMIT } from "../../automations/automation.ts";
import { getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import { deleteSlateAgentDbWriteGeneration, getSlateAgentDbWriteGeneration } from "../../storage/store-db.ts";
import { limitSurfacedWorkflows, type WorkflowSpec } from "../../../shared/workflow-model.ts";
import { SlateAgentDb, type AwaitingUserResponse, type TranscriptEntry } from "./agent-db.ts";
import { recoverAgentWithMissingDb, setAgentAvatarBytes } from "./session-mutations.ts";
import { getAgentAvatar, getAgentAvatarPng, getAgentProfileText, updateAgentProfile } from "./session-profile-files.ts";
import { listAgents, summarizeAgentById } from "./session-roster.ts";
import { buildSummary, loadAgentDbExtras, type DbExtras } from "./session-summaries.ts";
import { SlateConnectorSecretStore } from "./connector-secret-store.ts";
import { ensureConversationCapacityForTurn } from "./conversation-size-limits.ts";
import { expirePendingAutoReviewApprovalEntries, expirePendingLocalToolPermissionAskEntries } from "./pending-card-sweeps.ts";
import { ACTIVE_AGENT_FILENAME, getAgentDbPath, getConnectorSecretsRoot, statIfExists } from "./session-paths.ts";
import { automationStoreForDbPath, channelStoreForDbPath, NO_SESSION_MEMORY, workflowStoreForDbPath } from "./session-store-factories.ts";
import { publishTranscriptMutation } from "../../transcript/transcript-mutation-events.ts";
import { reportSessionDiagnostic } from "./session-diagnostics.ts";
import { seedActivityFromMtime } from "./session-projection.ts";

export interface OpenAgentSession {
  id: string;
  dbPath: string;
  db: SlateAgentDb;
  agentStore: { getFullConversation?(ctx: unknown): Promise<unknown>; dispose(): Promise<void> };
}
export interface SessionMemoryProvider {
  agentHasContent(agentDir: string): boolean;
  createAgentStore?(agentDir: string): unknown;
}
export interface MaterializationPort {
  closeWorkerPool?(): Promise<void>;
  listAgentRecordIds?(): Promise<string[]>;
  countOwnedAgents?(): Promise<number>;
  mintAgent?(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  createSession?(profile: Partial<SlateAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession>;
  createFallbackSession?(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession>;
  openSession?(agentId: string): Promise<OpenAgentSession>;
  requireWorkerPool?(): { collectConversationGarbage(args: Record<string, unknown>): Promise<unknown> };
  isAgentCapReached?(): Promise<boolean>;
}
export interface ConversationStatePort {
  getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]>;
  getSessionOutline(session: OpenAgentSession): Promise<unknown>;
  getAgentOutline(agentId: string): Promise<unknown>;
  getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]>;
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[];
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }): ReturnType<SlateAgentDb["getTranscriptPage"]>;
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit: number }): ReturnType<SlateAgentDb["getTranscriptWindow"]>;
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit: number }): ReturnType<SlateAgentDb["getTranscriptTail"]>;
  readAgentThread(agentId: string, rootId: string): ReturnType<SlateAgentDb["getThread"]>;
}
export interface AgentSessionStoreOptions {
  materialization?: MaterializationPort;
  createMaterialization?(store: SlateAgentSessionStore): MaterializationPort;
  conversationState?: ConversationStatePort;
  createConversationState?(store: SlateAgentSessionStore): ConversationStatePort;
  onAgentRemoved?(agentId: string): void;
}

export function resolveProfileName(trimmedName: string, current?: { name?: string } | null): string { if (trimmedName) return trimmedName; if (current?.name?.trim()) return current.name; return "New Bot"; }

export class SlateAgentSessionStore {
  private memory: SessionMemoryProvider = NO_SESSION_MEMORY;
  private isAgentBeingDeleted: (id: string) => boolean = () => false;
  private resolveUserTimeZone: () => string | undefined;
  private readonly extrasCache = new Map<string, { key: string; extras: DbExtras }>();
  readonly connectorSecrets: SlateConnectorSecretStore;
  readonly materialization: MaterializationPort | undefined;
  readonly conversationState: ConversationStatePort | undefined;

  constructor(readonly rootDir = getSlateAgentsRootDir(), resolveUserTimeZone: () => string | undefined = () => undefined, readonly options: AgentSessionStoreOptions = {}) {
    this.resolveUserTimeZone = resolveUserTimeZone;
    this.connectorSecrets = new SlateConnectorSecretStore(getConnectorSecretsRoot(rootDir));
    this.materialization = options.materialization ?? options.createMaterialization?.(this);
    this.conversationState = options.conversationState ?? options.createConversationState?.(this);
  }
  getRootDir(): string { return this.rootDir; }
  setMemory(memory: SessionMemoryProvider): void { this.memory = memory; }
  createMemoryStore(agentDir: string): unknown { return this.memory.createAgentStore?.(agentDir) ?? NO_SESSION_MEMORY.createAgentStore(); }
  setBeingDeletedPredicate(predicate: (id: string) => boolean): void { this.isAgentBeingDeleted = predicate; }
  setUserTimeZoneResolver(resolve: () => string | undefined): void { this.resolveUserTimeZone = resolve; }
  getUserTimeZone(): string | undefined { return this.resolveUserTimeZone(); }
  async closeWorkerPool(): Promise<void> { await this.materialization?.closeWorkerPool?.(); }
  async listAgentRecordIds(): Promise<string[]> { return this.materialization?.listAgentRecordIds?.() ?? this.listAgentIds(); }
  async countOwnedAgents(): Promise<number> { return this.materialization?.countOwnedAgents?.() ?? (await this.listAgentIds()).length; }

  getAgentDir(agentId: string): string { return join(this.rootDir, agentId); }
  agentExists(agentId: string): boolean { return existsSync(getAgentDbPath(this.rootDir, agentId)); }
  agentDirExists(agentId: string): boolean { return existsSync(this.getAgentDir(agentId)); }
  writeAgentProfileFile(agentId: string, profile: Partial<SlateAgentProfile> & { name: string; description: string }): void {
    const path = getSlateProfilePath(this.getAgentDir(agentId)), current = readSlateProfileFile(path), name = resolveProfileName(profile.name.trim(), current);
    writeSlateProfileFile(path, { name, description: profile.description.trim(), title: profile.title?.trim() ?? current?.title ?? "", avatarShape: profile.avatarShape?.trim() ?? current?.avatarShape ?? "", avatarColor: profile.avatarColor?.trim() ?? current?.avatarColor ?? "" });
  }
  async withAgentDb<T>(agentId: string, fn: (db: SlateAgentDb, dbPath: string) => T | Promise<T>): Promise<T> { const dbPath = getAgentDbPath(this.rootDir, agentId), db = new SlateAgentDb(dbPath); try { return await fn(db, dbPath); } finally { db.close(); } }

  private async createLocalSession(profile: Partial<SlateAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession> {
    let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID();
    mkdirSync(this.getAgentDir(id), { recursive: true });
    this.writeAgentProfileFile(id, { name: profile.name ?? "New Bot", description: profile.description ?? "", ...(profile.title == null ? {} : { title: profile.title }), ...(profile.avatarShape == null ? {} : { avatarShape: profile.avatarShape }), ...(profile.avatarColor == null ? {} : { avatarColor: profile.avatarColor }) });
    const dbPath = getAgentDbPath(this.rootDir, id), db = new SlateAgentDb(dbPath); db.set("agentId", id); db.setAgentOrigin(origin); if (purpose != null) db.setAgentPurpose(purpose); db.setIntroductionPending(true);
    return { id, dbPath, db, agentStore: { dispose: async () => {} } };
  }
  async createSession(profile: Partial<SlateAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<OpenAgentSession> { return this.materialization?.createSession != null ? this.materialization.createSession(profile, origin, purpose) : this.createLocalSession(profile, origin, purpose); }
  async mintAgent(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { if (this.materialization?.mintAgent != null) return this.materialization.mintAgent(mint); let id = randomUUID(); while (this.agentDirExists(id)) id = randomUUID(); return mint(id); }
  async createFallbackSession(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> { if (this.materialization?.createFallbackSession != null) return this.materialization.createFallbackSession(open); const [agentId] = await this.listAgentIds(); if (agentId == null) throw new Error("No fallback session is available"); return open(agentId); }
  async openSession(agentId: string): Promise<OpenAgentSession> { if (this.materialization?.openSession != null) return this.materialization.openSession(agentId); if (!this.agentExists(agentId)) throw new Error(`Agent missing: ${agentId}`); const dbPath = getAgentDbPath(this.rootDir, agentId); return { id: agentId, dbPath, db: new SlateAgentDb(dbPath), agentStore: { dispose: async () => {} } }; }
  async deleteSession(agentId: string): Promise<void> { const dbPath = getAgentDbPath(this.rootDir, agentId); this.extrasCache.delete(agentId); deleteSlateAgentDbWriteGeneration(dbPath); await rm(this.getAgentDir(agentId), { recursive: true, force: true }); publishTranscriptMutation({ kind: "agent-removed", agentId }); this.options.onAgentRemoved?.(agentId); }

  activeAgentPointerPath(): string { return join(this.rootDir, ACTIVE_AGENT_FILENAME); }
  readActiveAgentId(): string | null { try { const parsed = JSON.parse(readFileSync(this.activeAgentPointerPath(), "utf8")) as { activeAgentId?: unknown }; const id = parsed.activeAgentId; return typeof id === "string" && id.length > 0 ? id : null; } catch { return null; } }
  writeActiveAgentId(agentId: string): void { try { mkdirSync(this.rootDir, { recursive: true }); const path = this.activeAgentPointerPath(), temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify({ activeAgentId: agentId })); renameSync(temp, path); } catch {} }

  async updateAgentProfile(agentId: string, profile: Partial<SlateAgentProfile> & { name: string; description: string }): Promise<Record<string, unknown> | null> { return updateAgentProfile(this.profileFilesHost(), agentId, profile); }
  getAgentProfileText(agentId: string): SlateAgentProfile | null { return getAgentProfileText(this, agentId); }
  getAgentAvatar(agentId: string) { return getAgentAvatar(this, agentId); }
  getAgentAvatarPng(agentId: string) { return getAgentAvatarPng(this, agentId); }
  async setAgentAvatarBytes(db: SlateAgentDb, dbPath: string, agentId: string, pngBytes: Uint8Array | null, activeAgentId?: string) { return setAgentAvatarBytes({ memory: this.memory }, db, dbPath, agentId, pngBytes, activeAgentId); }
  async setAgentAvatarBytesById(agentId: string, pngBytes: Uint8Array | null) { return this.withAgentDb(agentId, (db, dbPath) => this.setAgentAvatarBytes(db, dbPath, agentId, pngBytes, undefined)); }
  async summarizeOpenSession(session: OpenAgentSession): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras: loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      activeAgentId: session.id,
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  async summarizeSession(session: OpenAgentSession, activeAgentId?: string): Promise<Record<string, unknown> | null> {
    const dbStats = await statIfExists(session.dbPath);
    if (this.isAgentBeingDeleted(session.id)) return null;
    const extras = dbStats == null
      ? loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats)
      : await this.loadCachedExtras({
          dirName: session.id,
          dbPath: session.dbPath,
          dbStats,
          readExtras: () => loadAgentDbExtras(session.db, session.dbPath, session.id, dbStats),
        });
    if (this.isAgentBeingDeleted(session.id)) return null;
    return await buildSummary({
      extras,
      dbPath: session.dbPath,
      dirName: session.id,
      ...(dbStats === undefined ? {} : { dbStats }),
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      includeBlank: true,
      agentHasMemory: candidate => this.memory.agentHasContent(candidate),
    });
  }
  private async loadCachedExtras(args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number }; readExtras?: () => DbExtras | null }): Promise<DbExtras | null> {
    const walStats = await statIfExists(`${args.dbPath}-wal`);
    const generation = getSlateAgentDbWriteGeneration(args.dbPath);
    const key = `${generation}:${args.dbStats.size}:${args.dbStats.mtimeMs}:${walStats?.size ?? -1}:${walStats?.mtimeMs ?? -1}`;
    const cached = this.extrasCache.get(args.dirName);
    if (cached?.key === key && existsSync(getSlateProfilePath(join(this.rootDir, args.dirName)))) return cached.extras;
    if (this.isAgentBeingDeleted(args.dirName)) return null;
    const extras = args.readExtras?.() ?? this.readExtrasFromDisk(args.dbPath, args.dirName, args.dbStats);
    if (extras != null) this.extrasCache.set(args.dirName, { key, extras });
    return extras;
  }
  private readExtrasFromDisk(dbPath: string, dirName: string, dbStats: { size: number; mtimeMs: number }): DbExtras | null {
    let db: SlateAgentDb;
    try { db = new SlateAgentDb(dbPath, { recoverOnCorruption: false }); }
    catch (error) {
      reportSessionDiagnostic({ family: "store_db", kind: "unreadable", agentId: dirName, errorClass: errorLogTag(error) });
      return null;
    }
    try { return loadAgentDbExtras(db, dbPath, dirName, dbStats); }
    finally { db.close(); }
  }
  private reseedMinimalStoreDbIfMissing(dbPath: string): void { const db = new SlateAgentDb(dbPath); db.close(); }
  private rosterHost() { return { rootDir: this.rootDir, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), memory: this.memory, loadCachedExtras: (args: { dirName: string; dbPath: string; dbStats: { size: number; mtimeMs: number } }) => this.loadCachedExtras(args), recoverAgentWithMissingDb: (args: { dbPath: string; dirName: string; activeAgentId?: string }) => recoverAgentWithMissingDb({ memory: this.memory, isAgentBeingDeleted: (id: string) => this.isAgentBeingDeleted(id), reseedMinimalStoreDbIfMissing: (path: string) => this.reseedMinimalStoreDbIfMissing(path) }, args), pruneExtrasCache: (ids: Set<string>) => { for (const id of this.extrasCache.keys()) if (!ids.has(id)) this.extrasCache.delete(id); } }; }
  async summarizeAgentById(agentId: string, activeAgentId?: string): Promise<Record<string, unknown> | null> { return summarizeAgentById(this.rosterHost(), agentId, activeAgentId); }
  async listAgents(activeAgentId?: string): Promise<Record<string, unknown>[]> { return listAgents(this.rosterHost(), activeAgentId); }
  async listAgentIds(): Promise<string[]> { try { return (await readdir(this.rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }

  async getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]> { return this.conversationState?.getTranscriptEntries(session) ?? session.db.getTranscriptEntries(); }
  async getSessionOutline(session: OpenAgentSession): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getSessionOutline(session); }
  async getAgentOutline(agentId: string): Promise<unknown> { if (this.conversationState == null) throw new Error("Session conversation-state provider is required"); return this.conversationState.getAgentOutline(agentId); }
  async getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]> { return this.conversationState?.getAgentTranscriptEntries(agentId) ?? this.withAgentDb(agentId, (db) => db.getTranscriptEntries()); }
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[] { return this.conversationState?.readAgentTranscriptEntries(agentId) ?? []; }
  readAgentTranscriptPage(agentId: string, query: { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }) { return this.conversationState?.readAgentTranscriptPage(agentId, query) ?? { entries: [] }; }
  readAgentTranscriptWindow(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptWindow(agentId, query) ?? { entries: [], threadCounts: {} }; }
  readAgentTranscriptTail(agentId: string, query: { beforeSeq?: number; limit: number }) { return this.conversationState?.readAgentTranscriptTail(agentId, query) ?? { entries: [] }; }
  readAgentThread(agentId: string, rootId: string) { return this.conversationState?.readAgentThread(agentId, rootId) ?? { entries: [] }; }

  // Recovered from the shipped host bundle (host-main.cjs:632999-633002), where this backfills a
  // legacy agent's lastActivityAt from its store-db mtime before the viewed mark is written. The
  // reconstruction kept the call site in agent-lifecycle.ts but dropped the definition, so every
  // caller threw "seedSessionActivityFromDbMtime is not a function".
  async markSessionViewed(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { await this.seedSessionActivityFromDbMtime(session); session.db.markViewed(at, options); }
  // Deliberately skips the mtime seed: it only backfills a legacy agent's lastActivityAt while
  // listing and is a no-op once activity is recorded, which it always is on the session that just
  // marked activity. Staying synchronous keeps the activity mark and the viewed mark in one tick,
  // so the active row can never be observed unread between them.
  markSessionViewedNow(session: OpenAgentSession, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): void { session.db.markViewed(at, options); }
  markSessionActivity(session: OpenAgentSession, at = Date.now()): void { session.db.markActivity(at); }
  async markAgentViewed(agentId: string, at = Date.now(), options: { preserveManualUnread?: boolean } = {}): Promise<void> { try { await this.withAgentDb(agentId, (db) => db.markViewed(at, options)); } catch {} }
  async setSessionUnread(agentId: string, unread: boolean, at = Date.now()): Promise<void> { await this.withAgentDb(agentId, (db) => unread ? db.markUnread(at) : db.markRead(at)); }
  setSessionNotifyOnUpdates(agentId: string, enabled: boolean): void { writeSlateSettingsFile(getSlateSettingsPath(this.getAgentDir(agentId)), { notifyOnAgentUpdates: enabled }); }
  setSessionHiddenFromSidebar(agentId: string, hidden: boolean): void { writeSlateSettingsFile(getSlateSettingsPath(this.getAgentDir(agentId)), { hiddenFromSidebar: hidden }); }
  async setAwaitingUserResponse(agentId: string, state: AwaitingUserResponse | null): Promise<void> { await this.withAgentDb(agentId, (db) => { db.setAwaitingUserResponse(state); }); }
  async setAwaitingUserResponseForTab(agentId: string, tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): Promise<boolean> { return this.withAgentDb(agentId, (db) => db.setAwaitingUserResponseForTab(tabId, state, options)); }
  async expirePendingAutoReviewApprovals(agentId: string, onlyRequestId?: string): Promise<string[]> { return this.withAgentDb(agentId, (db) => expirePendingAutoReviewApprovalEntries(db as never, onlyRequestId)); }
  async expirePendingLocalToolPermissionAsks(args: { agentId: string; onlyRequestId?: string; ifPendingBeforeMs?: number }): Promise<string[]> { return this.withAgentDb(args.agentId, (db) => expirePendingLocalToolPermissionAskEntries(db as never, { ...(args.onlyRequestId == null ? {} : { onlyRequestId: args.onlyRequestId }), ...(args.ifPendingBeforeMs == null ? {} : { ifPendingBeforeMs: args.ifPendingBeforeMs }) })); }
  async clearAgentMemoryPromptSnapshot(agentId: string): Promise<void> { await this.withAgentDb(agentId, (db) => db.clearMemoryPromptSnapshot()); }
  async ensureConversationCapacityForTurn(session: OpenAgentSession): Promise<void> { if (this.materialization?.requireWorkerPool == null) return; await ensureConversationCapacityForTurn({ requireWorkerPool: () => this.materialization?.requireWorkerPool?.() as never }, session.dbPath, session.db); }

  automationStoreFor(agentId: string) { return automationStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  listAgentAutomations(agentId: string) { return this.automationStoreFor(agentId).list().slice(0, AUTOMATION_UI_LIMIT); }
  setAgentAutomationEnabled(agentId: string, automationId: string, enabled: boolean) { const store = this.automationStoreFor(agentId); store.setEnabled(automationId, enabled); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  createAgentAutomation(agentId: string, spec: Parameters<ReturnType<SlateAgentSessionStore["automationStoreFor"]>["upsert"]>[0]) { const store = this.automationStoreFor(agentId); store.upsert(spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  updateAgentAutomation(agentId: string, automationId: string, spec: Parameters<ReturnType<SlateAgentSessionStore["automationStoreFor"]>["update"]>[1]) { const store = this.automationStoreFor(agentId); store.update(automationId, spec); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  removeAgentAutomation(agentId: string, automationId: string) { const store = this.automationStoreFor(agentId); store.remove(automationId); return store.list().slice(0, AUTOMATION_UI_LIMIT); }
  workflowStoreFor(agentId: string) { return workflowStoreForDbPath(getAgentDbPath(this.rootDir, agentId), this.resolveUserTimeZone); }
  async listAgentWorkflows(agentId: string) { return limitSurfacedWorkflows(this.workflowStoreFor(agentId).listAll()); }
  async getAgentWorkflow(agentId: string, workflowId: string) { return this.workflowStoreFor(agentId).get(workflowId); }
  createAgentWorkflow(agentId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.create(spec); return limitSurfacedWorkflows(store.listAll()); }
  updateAgentWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec) { const store = this.workflowStoreFor(agentId); store.update(workflowId, spec); return limitSurfacedWorkflows(store.listAll()); }
  async setAgentWorkflowEnabled(agentId: string, workflowId: string, enabled: boolean) { const store = this.workflowStoreFor(agentId); store.setEnabledForAgent(workflowId, enabled); return limitSurfacedWorkflows(store.listAll()); }
  removeAgentWorkflow(agentId: string, workflowId: string) { const store = this.workflowStoreFor(agentId); store.remove(workflowId); return limitSurfacedWorkflows(store.listAll()); }
  async importAgentWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importMarkdown(markdown, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] } : { imported: [imported], skipped: [] } }; }
  async importAgentWorkflowSource(agentId: string, source: string, fallbackName?: string) { const store = this.workflowStoreFor(agentId), imported = store.importLiveSource(source, fallbackName); return { workflows: limitSurfacedWorkflows(store.listAll()), result: imported == null ? { imported: [], skipped: [{ source, reason: "could not link" }] } : { imported: [imported], skipped: [] } }; }
  async portAgentLocalSkills(agentId: string) { const store = this.workflowStoreFor(agentId), result = store.portLocalSkills(homedir(), process.cwd()); return { workflows: limitSurfacedWorkflows(store.listAll()), result }; }

  openChannelStore(agentId: string) { return channelStoreForDbPath(getAgentDbPath(this.rootDir, agentId)); }
  listAgentChannels(agentId: string) { return this.openChannelStore(agentId).listConnections().filter((connection) => this.connectorSecrets.getSecret(agentId, connection.platform, "token") != null); }
  listChannelConfigs(agentId: string): Array<{ platform: string; token: string; label: string }> { const store = this.openChannelStore(agentId), configs = []; for (const platform of store.listPlatforms()) { const token = this.connectorSecrets.getSecret(agentId, platform, "token"); if (token != null) configs.push({ platform, token, label: store.readLabel(platform) ?? platform }); } return configs; }
  storeConnectorCredential(agentId: string, platform: string, field: string, value: string): boolean { if (!this.connectorSecrets.setSecret(agentId, platform, field, value)) return false; this.openChannelStore(agentId).writeMetadata(platform, ""); return true; }
  disconnectChannel(agentId: string, platform: string): boolean { this.connectorSecrets.removeAgentPlatform(agentId, platform); return this.openChannelStore(agentId).remove(platform); }
  async listAllAutomationsFrom(options: { definitionsOnly: boolean }) { const result = []; for (const agentId of await this.listAgentIds()) { try { const store = this.automationStoreFor(agentId), automations = options.definitionsOnly ? store.listDefinitions() : store.list(); for (const automation of automations) result.push({ agentId, automation }); } catch {} } return result; }
  async listAllAutomations() { return this.listAllAutomationsFrom({ definitionsOnly: false }); }
  async listAllAutomationDefinitions() { return this.listAllAutomationsFrom({ definitionsOnly: true }); }
  async isAgentCapReached(): Promise<boolean> { return await this.materialization?.isAgentCapReached?.() ?? false; }
  // Recovered from the shipped host bundle (host-main.cjs:633284-633297): the stat failure is
  // reported as a `store_db`/`stat_failed` session diagnostic rather than swallowed, and the seed
  // is skipped when the db cannot be stat'ed.
  async seedSessionActivityFromDbMtime(session: OpenAgentSession): Promise<void> {
    const dbStats = await this.statOpenDb({ dbPath: session.dbPath, agentId: session.id });
    // `as never` matches the projection boundary's other call site (session-summaries.ts), where
    // the db is typed more widely than the seed's narrow structural view.
    seedActivityFromMtime(session.db as never, session.id, dbStats);
  }
  async statOpenDb(args: { dbPath: string; agentId: string }) {
    return await stat(args.dbPath).catch((error: unknown) => {
      reportSessionDiagnostic({
        family: "store_db",
        kind: "stat_failed",
        agentId: args.agentId,
        errorClass: errorLogTag(error)
      });
      return undefined;
    });
  }
  private profileFilesHost() { return { memory: this.memory, withAgentDb: <T>(agentId: string, fn: (db: SlateAgentDb, dbPath: string) => T | Promise<T>) => this.withAgentDb(agentId, fn), statOpenDb: (args: { dbPath: string; agentId: string }) => this.statOpenDb(args), writeAgentProfileFile: (agentId: string, profile: Partial<SlateAgentProfile> & { name: string; description: string }) => this.writeAgentProfileFile(agentId, profile) }; }
}
