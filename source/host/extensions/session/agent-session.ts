/**
 * A session, as the host holds it.
 *
 * The session owns its database, its transcript and the state it derives from both; what it exposes is the operations
 * the host performs on a session rather than the pieces it is built from.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorLogTag } from "../../../shared/errors/summary.ts";
import { getSlateProfilePath, readSlateProfileFile, writeSlateProfileFile, type SlateAgentProfile } from "../../agents/agent-profile.ts";
import { getSlateAgentsRootDir } from "../../storage/agent-paths.ts";
import { deleteSlateAgentDbWriteGeneration } from "../../storage/store-db.ts";
import type { WorkflowSpec } from "../../../shared/workflow-model.ts";
import { SlateAgentDb, type AwaitingUserResponse, type TranscriptEntry } from "./agent-db.ts";
import { SessionExtrasCache } from "./session-summary-cache.ts";
import { SessionSubresources } from "./session-subresources.ts";
import { SessionStoreProjection } from "./session-store-projection.ts";
import { SessionTranscriptReader } from "./session-transcript-reader.ts";
import { SessionStateOperations } from "./session-state-operations.ts";
import { SessionProfileOperations } from "./session-profile-operations.ts";
import { SlateConnectorSecretStore } from "./connector-secret-store.ts";
import { getAgentDbPath, getConnectorSecretsRoot } from "./session-paths.ts";
import { NO_SESSION_MEMORY } from "./session-store-factories.ts";
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
/** The window of a transcript a reader may ask for. */
export interface TranscriptWindowQuery { beforeSeq?: number; limit: number }

/** The page of a transcript a reader may ask for. */
export interface TranscriptPageQuery { beforeSeq?: number; sinceMs?: number; untilMs: number; limit: number }

/** What marking a session viewed may preserve. */
export interface ViewedMarkOptions { preserveManualUnread?: boolean }

export interface ConversationStatePort {
  getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]>;
  getSessionOutline(session: OpenAgentSession): Promise<unknown>;
  getAgentOutline(agentId: string): Promise<unknown>;
  getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]>;
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[];
  readAgentTranscriptPage(agentId: string, query: TranscriptPageQuery): ReturnType<SlateAgentDb["getTranscriptPage"]>;
  readAgentTranscriptWindow(agentId: string, query: TranscriptWindowQuery): ReturnType<SlateAgentDb["getTranscriptWindow"]>;
  readAgentTranscriptTail(agentId: string, query: TranscriptWindowQuery): ReturnType<SlateAgentDb["getTranscriptTail"]>;
  readAgentThread(agentId: string, rootId: string): ReturnType<SlateAgentDb["getThread"]>;
}
export interface AgentSessionStoreOptions {
  materialization?: MaterializationPort;
  createMaterialization?(store: SlateAgentSessionStore): MaterializationPort;
  conversationState?: ConversationStatePort;
  createConversationState?(store: SlateAgentSessionStore): ConversationStatePort;
  onAgentRemoved?(agentId: string): void;
}

/** The name a profile is shown under when nothing names it. */
const DEFAULT_PROFILE_NAME = "New Bot";
const EMPTY_AGENT_STORE = Object.freeze({ dispose: async () => {} });

/** The name a profile is written under: the name given, else the current one, else the default. */
export function resolveProfileName(trimmedName: string, current?: { name?: string } | null): string {
  if (trimmedName) return trimmedName;
  if (current?.name?.trim()) return current.name;
  return DEFAULT_PROFILE_NAME;
}

export class SlateAgentSessionStore {
  private memory: SessionMemoryProvider = NO_SESSION_MEMORY;
  private isBeingDeleted: (id: string) => boolean = () => false;
  private resolveUserTimeZone: () => string | undefined;
  private readonly extrasCacheService: SessionExtrasCache;
  private readonly subresources: SessionSubresources;
  private readonly projection: SessionStoreProjection;
  private readonly transcriptReader: SessionTranscriptReader;
  private readonly stateOperations: SessionStateOperations;
  private readonly profileOperations: SessionProfileOperations;
  readonly connectorSecrets: SlateConnectorSecretStore;
  readonly materialization: MaterializationPort | undefined;
  readonly conversationState: ConversationStatePort | undefined;

  constructor(readonly rootDir = getSlateAgentsRootDir(), timeZoneReader: () => string | undefined = () => undefined, readonly options: AgentSessionStoreOptions = {}) {
    this.resolveUserTimeZone = timeZoneReader;
    this.extrasCacheService = new SessionExtrasCache(rootDir, agentId => this.isBeingDeleted(agentId));
    this.projection = new SessionStoreProjection({
      rootDir,
      memory: () => this.memory,
      isAgentBeingDeleted: agentId => this.isBeingDeleted(agentId),
      cache: this.extrasCacheService,
      reseedMinimalStoreDb: dbPath => this.reseedMinimalStoreDbIfMissing(dbPath),
    });
    this.transcriptReader = new SessionTranscriptReader(
      () => this.conversationState,
      (agentId, operation) => this.withAgentDb(agentId, operation),
    );
    this.stateOperations = new SessionStateOperations(
      agentId => this.getAgentDir(agentId),
      (agentId, operation) => this.withAgentDb(agentId, operation),
      session => this.seedSessionActivityFromDbMtime(session),
      () => this.materialization?.requireWorkerPool,
    );
    this.profileOperations = new SessionProfileOperations({
      rootDir,
      agentDir: agentId => this.getAgentDir(agentId),
      withAgentDb: (agentId, operation) => this.withAgentDb(agentId, operation),
      writeProfileFile: (agentId, profile) => this.writeAgentProfileFile(agentId, profile),
      statOpenDb: args => this.statOpenDb(args),
      memory: () => this.memory,
    });
    this.connectorSecrets = new SlateConnectorSecretStore(getConnectorSecretsRoot(rootDir));
    this.subresources = new SessionSubresources(rootDir, () => this.resolveUserTimeZone(), this.connectorSecrets);
    this.materialization = options.materialization ?? options.createMaterialization?.(this);
    this.conversationState = options.conversationState ?? options.createConversationState?.(this);
  }
  getRootDir(): string { return this.rootDir; }
  setMemory(memory: SessionMemoryProvider): void { this.memory = memory; }
  createMemoryStore(agentDir: string): unknown { return this.memory.createAgentStore?.(agentDir) ?? NO_SESSION_MEMORY.createAgentStore(); }
  setBeingDeletedPredicate(predicate: (id: string) => boolean): void { this.isBeingDeleted = predicate; }
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
  async withAgentDb<Result>(agentId: string, operation: (db: SlateAgentDb, dbPath: string) => Result | Promise<Result>): Promise<Result> { const dbPath = getAgentDbPath(this.rootDir, agentId), db = new SlateAgentDb(dbPath); try { return await operation(db, dbPath); } finally { db.close(); } }

  private async createLocalSession(profile: Partial<SlateAgentProfile>, origin: "user" | "dev", purpose?: string): Promise<OpenAgentSession> {
    const id = this.uniqueAgentId();
    const agentDir = this.getAgentDir(id);
    mkdirSync(agentDir, { recursive: true });
    try {
      this.writeAgentProfileFile(id, {
        name: profile.name ?? DEFAULT_PROFILE_NAME,
        description: profile.description ?? "",
        ...(profile.title == null ? {} : { title: profile.title }),
        ...(profile.avatarShape == null ? {} : { avatarShape: profile.avatarShape }),
        ...(profile.avatarColor == null ? {} : { avatarColor: profile.avatarColor }),
      });
      const dbPath = getAgentDbPath(this.rootDir, id);
      const db = new SlateAgentDb(dbPath);
      db.set("agentId", id);
      db.setAgentOrigin(origin);
      if (purpose != null) db.setAgentPurpose(purpose);
      db.setIntroductionPending(true);
      return { id, dbPath, db, agentStore: EMPTY_AGENT_STORE };
    } catch (error) {
      await rm(agentDir, { recursive: true, force: true });
      throw error;
    }
  }
  private uniqueAgentId(): string {
    let candidate = randomUUID();
    while (this.agentDirExists(candidate)) candidate = randomUUID();
    return candidate;
  }
  async createSession(profile: Partial<SlateAgentProfile>, origin: "user" | "dev" = "user", purpose?: string): Promise<OpenAgentSession> {
    return this.materialization?.createSession?.(profile, origin, purpose)
      ?? this.createLocalSession(profile, origin, purpose);
  }
  async mintAgent(mint: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> {
    return this.materialization?.mintAgent?.(mint) ?? mint(this.uniqueAgentId());
  }
  async createFallbackSession(open: (agentId: string) => Promise<OpenAgentSession>): Promise<OpenAgentSession> {
    if (this.materialization?.createFallbackSession != null) {
      return this.materialization.createFallbackSession(open);
    }
    const [agentId] = await this.listAgentIds();
    if (agentId == null) throw new Error("No fallback session is available");
    return open(agentId);
  }
  async openSession(agentId: string): Promise<OpenAgentSession> {
    if (this.materialization?.openSession != null) return this.materialization.openSession(agentId);
    if (!this.agentExists(agentId)) throw new Error(`Agent missing: ${agentId}`);
    const dbPath = getAgentDbPath(this.rootDir, agentId);
    return { id: agentId, dbPath, db: new SlateAgentDb(dbPath), agentStore: EMPTY_AGENT_STORE };
  }
  async deleteSession(agentId: string): Promise<void> {
    const dbPath = getAgentDbPath(this.rootDir, agentId);
    await rm(this.getAgentDir(agentId), { recursive: true, force: true });
    this.extrasCacheService.clear(agentId);
    deleteSlateAgentDbWriteGeneration(dbPath);
    publishTranscriptMutation({ kind: "agent-removed", agentId });
    this.options.onAgentRemoved?.(agentId);
  }

  activeAgentPointerPath(): string { return this.profileOperations.activePointerPath(); }
  readActiveAgentId(): string | null { return this.profileOperations.readActiveAgentId(); }
  writeActiveAgentId(agentId: string): void { this.profileOperations.writeActiveAgentId(agentId); }

  async updateAgentProfile(agentId: string, profile: Partial<SlateAgentProfile> & { name: string; description: string }): Promise<Record<string, unknown> | null> { return this.profileOperations.update(agentId, profile); }
  getAgentProfileText(agentId: string): SlateAgentProfile | null { return this.profileOperations.profileText(agentId); }
  getAgentAvatar(agentId: string) { return this.profileOperations.avatar(agentId); }
  getAgentAvatarPng(agentId: string) { return this.profileOperations.avatarPng(agentId); }
  async setAgentAvatarBytes(db: SlateAgentDb, dbPath: string, agentId: string, pngBytes: Uint8Array | null, activeAgentId?: string) { return this.profileOperations.setAvatar(db, dbPath, agentId, pngBytes, activeAgentId); }
  async setAgentAvatarBytesById(agentId: string, pngBytes: Uint8Array | null) { return this.profileOperations.setAvatarById(agentId, pngBytes); }
  async summarizeOpenSession(session: OpenAgentSession): Promise<Record<string, unknown> | null> {
    return this.projection.summarizeOpen(session)
  }
  async summarizeSession(session: OpenAgentSession, activeAgentId?: string): Promise<Record<string, unknown> | null> {
    return this.projection.summarize(session, activeAgentId)
  }
  private reseedMinimalStoreDbIfMissing(dbPath: string): void { const db = new SlateAgentDb(dbPath); db.close(); }
  async summarizeAgentById(agentId: string, activeAgentId?: string): Promise<Record<string, unknown> | null> { return this.projection.summarizeAgent(agentId, activeAgentId); }
  async listAgents(activeAgentId?: string): Promise<Record<string, unknown>[]> { return this.projection.list(activeAgentId); }
  async listAgentIds(): Promise<string[]> { try { return (await readdir(this.rootDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }

  async getTranscriptEntries(session: OpenAgentSession): Promise<TranscriptEntry[]> { return this.transcriptReader.entries(session); }
  async getSessionOutline(session: OpenAgentSession): Promise<unknown> { return this.transcriptReader.sessionOutline(session); }
  async getAgentOutline(agentId: string): Promise<unknown> { return this.transcriptReader.agentOutline(agentId); }
  async getAgentTranscriptEntries(agentId: string): Promise<TranscriptEntry[]> { return this.transcriptReader.agentEntries(agentId); }
  readAgentTranscriptEntries(agentId: string): TranscriptEntry[] { return this.transcriptReader.synchronousEntries(agentId); }
  readAgentTranscriptPage(agentId: string, query: TranscriptPageQuery) { return this.transcriptReader.page(agentId, query); }
  readAgentTranscriptWindow(agentId: string, query: TranscriptWindowQuery) { return this.transcriptReader.window(agentId, query); }
  readAgentTranscriptTail(agentId: string, query: TranscriptWindowQuery) { return this.transcriptReader.tail(agentId, query); }
  readAgentThread(agentId: string, rootId: string) { return this.transcriptReader.thread(agentId, rootId); }

  async markSessionViewed(session: OpenAgentSession, at = Date.now(), options: ViewedMarkOptions = {}): Promise<void> { return this.stateOperations.markViewed(session, at, options); }
  markSessionViewedNow(session: OpenAgentSession, at = Date.now(), options: ViewedMarkOptions = {}): void { this.stateOperations.markViewedNow(session, at, options); }
  markSessionActivity(session: OpenAgentSession, at = Date.now()): void { this.stateOperations.markActivity(session, at); }
  async markAgentViewed(agentId: string, at = Date.now(), options: ViewedMarkOptions = {}): Promise<void> { return this.stateOperations.markAgentViewed(agentId, at, options); }
  async setSessionUnread(agentId: string, unread: boolean, at = Date.now()): Promise<void> { return this.stateOperations.setUnread(agentId, unread, at); }
  setSessionNotifyOnUpdates(agentId: string, enabled: boolean): void { this.stateOperations.setNotifyOnUpdates(agentId, enabled); }
  setSessionHiddenFromSidebar(agentId: string, hidden: boolean): void { this.stateOperations.setHiddenFromSidebar(agentId, hidden); }
  async setAwaitingUserResponse(agentId: string, state: AwaitingUserResponse | null): Promise<void> { return this.stateOperations.setAwaitingResponse(agentId, state); }
  async setAwaitingUserResponseForTab(agentId: string, tabId: string, state: AwaitingUserResponse | null, options?: { ifSinceBefore?: number }): Promise<boolean> { return this.stateOperations.setAwaitingResponseForTab(agentId, tabId, state, options); }
  async expirePendingAutoReviewApprovals(agentId: string, onlyRequestId?: string): Promise<string[]> { return this.stateOperations.expireApprovals(agentId, onlyRequestId); }
  async expirePendingLocalToolPermissionAsks(args: { agentId: string; onlyRequestId?: string; ifPendingBeforeMs?: number }): Promise<string[]> { return this.stateOperations.expirePermissionAsks(args); }
  async clearAgentMemoryPromptSnapshot(agentId: string): Promise<void> { return this.stateOperations.clearMemoryPromptSnapshot(agentId); }
  async ensureConversationCapacityForTurn(session: OpenAgentSession): Promise<void> { return this.stateOperations.ensureConversationCapacity(session); }

  automationStoreFor(agentId: string) { return this.subresources.automationStore(agentId); }
  listAgentAutomations(agentId: string) { return this.subresources.listAutomations(agentId); }
  setAgentAutomationEnabled(agentId: string, automationId: string, enabled: boolean) { return this.subresources.setAutomationEnabled(agentId, automationId, enabled); }
  createAgentAutomation(agentId: string, spec: Parameters<ReturnType<SlateAgentSessionStore["automationStoreFor"]>["upsert"]>[0]) { return this.subresources.createAutomation(agentId, spec); }
  updateAgentAutomation(agentId: string, automationId: string, spec: Parameters<ReturnType<SlateAgentSessionStore["automationStoreFor"]>["update"]>[1]) { return this.subresources.updateAutomation(agentId, automationId, spec); }
  removeAgentAutomation(agentId: string, automationId: string) { return this.subresources.removeAutomation(agentId, automationId); }
  workflowStoreFor(agentId: string) { return this.subresources.workflowStore(agentId); }
  async listAgentWorkflows(agentId: string) { return this.subresources.listWorkflows(agentId); }
  async getAgentWorkflow(agentId: string, workflowId: string) { return this.subresources.getWorkflow(agentId, workflowId); }
  createAgentWorkflow(agentId: string, spec: WorkflowSpec) { return this.subresources.createWorkflow(agentId, spec); }
  updateAgentWorkflow(agentId: string, workflowId: string, spec: WorkflowSpec) { return this.subresources.updateWorkflow(agentId, workflowId, spec); }
  async setAgentWorkflowEnabled(agentId: string, workflowId: string, enabled: boolean) { return this.subresources.setWorkflowEnabled(agentId, workflowId, enabled); }
  removeAgentWorkflow(agentId: string, workflowId: string) { return this.subresources.removeWorkflow(agentId, workflowId); }
  async importAgentWorkflowMarkdown(agentId: string, markdown: string, fallbackName?: string) { return this.subresources.importWorkflowMarkdown(agentId, markdown, fallbackName); }
  async importAgentWorkflowSource(agentId: string, source: string, fallbackName?: string) { return this.subresources.importWorkflowSource(agentId, source, fallbackName); }
  async portAgentLocalSkills(agentId: string) { return this.subresources.portLocalSkills(agentId); }

  openChannelStore(agentId: string) { return this.subresources.channelStore(agentId); }
  listAgentChannels(agentId: string) { return this.subresources.listChannels(agentId); }
  listChannelConfigs(agentId: string): Array<{ platform: string; token: string; label: string }> { return this.subresources.listChannelConfigs(agentId); }
  storeConnectorCredential(agentId: string, platform: string, field: string, value: string): boolean { return this.subresources.storeCredential(agentId, platform, field, value); }
  disconnectChannel(agentId: string, platform: string): boolean { return this.subresources.disconnectChannel(agentId, platform); }
  async listAllAutomationsFrom(options: { definitionsOnly: boolean }) { const result = []; for (const agentId of await this.listAgentIds()) { try { const store = this.automationStoreFor(agentId), automations = options.definitionsOnly ? store.listDefinitions() : store.list(); for (const automation of automations) result.push({ agentId, automation }); } catch {} } return result; }
  async listAllAutomations() { return this.listAllAutomationsFrom({ definitionsOnly: false }); }
  async listAllAutomationDefinitions() { return this.listAllAutomationsFrom({ definitionsOnly: true }); }
  async isAgentCapReached(): Promise<boolean> { return await this.materialization?.isAgentCapReached?.() ?? false; }
  /** Read the database file time for the legacy activity seed; a failed stat is reported and produces no seed. */
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
}
