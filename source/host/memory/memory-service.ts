/** What an agent remembers about its user, kept as facts on disk.

 * The profile and the log are ordinary files of dated lines, read back into facts with their own ids, added to without
 * writing the same thing twice, and watched so a change made elsewhere is noticed. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DebouncePolicy } from "../extensions/scheduling.ts";
import { MEMORY_PROFILE_PROMPT_LIMIT, formatMemoryDate, memoryDedupeKey, normalizeMemoryContent } from "../runner/slate-memory.ts";
import { WatchedDirectory } from "../watched-directory.ts";
import type { AgentProjectMembership } from "./project-membership.ts";

export const MEMORY_DIRNAME = "memory";
export const PROFILE_FILENAME = "profile.md";
export const LOG_DIRNAME = "log";
export const MEMORY_SYNTHESIS_INPUT_LIMIT = 512;
export const MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MEMORY_CHANGE_DEBOUNCE_MS = 50;
const METADATA_DIRNAME = ".dreaming";
const PROFILE_HEADER = "# About the user\n\n<!-- Enduring facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
const LOG_HEADER = "# Memory log\n\n<!-- Dated facts, one per line as \"- (YYYY-MM-DD) <fact>\". -->\n\n";
const FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;

export type MemoryKind = "profile" | "log";
export type MemoryOrigin = "explicit" | "synthesis" | "legacy";
export interface MemoryRecord { id: string; content: string; createdAt: number; kind: MemoryKind }
interface MemoryFact extends MemoryRecord { origin: MemoryOrigin; path: string; line: number; order: number }
export type SynthesisChange =
  | { action: "create"; content: string; kind: MemoryKind }
  | { action: "update"; id: string; content: string; kind: MemoryKind }
  | { action: "remove"; id: string };
export interface SynthesisSnapshot { fingerprint: string; memories: Array<MemoryRecord & { origin: MemoryOrigin }> }
export interface DreamingBridge { isEnabled(): boolean; record(evidence: unknown): void }

export function getAgentMemoryDir(agentDir: string): string { return join(agentDir, MEMORY_DIRNAME); }
export function memoryIdFor(content: string): string { return createHash("sha1").update(memoryDedupeKey(content)).digest("hex").slice(0, 16); }
export function serializeFactLine(content: string, createdAt: number): string { return `- (${formatMemoryDate(createdAt)}) ${content}`; }
export function parseFacts(sourceText: string, kind: MemoryKind, path = "", base = 0): MemoryFact[] {
  const facts: MemoryFact[] = [];
  for (const [line, lineText] of sourceText.split("\n").entries()) {
    const match = FACT_LINE.exec(lineText); if (match == null) continue;
    const content = normalizeMemoryContent(match[2] ?? ""); if (!content) continue;
    const createdAt = Date.parse(`${match[1]}T00:00:00Z`);
    facts.push({ id: memoryIdFor(content), content, createdAt: Number.isFinite(createdAt) ? createdAt : 0, kind, origin: "legacy", path, line, order: base + facts.length });
  }
  return facts;
}
export function agentMemoryHasContent(agentDir: string): boolean {
  const memoryDirectory = getAgentMemoryDir(agentDir), logDir = join(memoryDirectory, LOG_DIRNAME);
  let logs: string[] = []; try { logs = readdirSync(logDir).filter((fileName) => fileName.endsWith(".md")).map((fileName) => join(logDir, fileName)); } catch {}
  return [join(memoryDirectory, PROFILE_FILENAME), ...logs].some((path) => { try { return parseFacts(readFileSync(path, "utf8"), path.endsWith(PROFILE_FILENAME) ? "profile" : "log").length > 0; } catch { return false; } });
}

export class FileMemoryStore {
  readonly dir: WatchedDirectory;
  readonly profileFile: string;
  readonly logDir: string;
  readonly explicitDir: string;
  readonly generatedDir: string;
  readonly tombstoneDir: string;
  readonly refreshFile: string;
  constructor(readonly memoryDirectory: string, debounce: DebouncePolicy, readonly dreaming?: DreamingBridge) {
    this.dir = new WatchedDirectory(memoryDirectory, debounce);
    this.profileFile = join(memoryDirectory, PROFILE_FILENAME);
    this.logDir = join(memoryDirectory, LOG_DIRNAME);
    const metadata = join(memoryDirectory, METADATA_DIRNAME);
    this.explicitDir = join(metadata, "explicit"); this.generatedDir = join(metadata, "synthesized"); this.tombstoneDir = join(metadata, "tombstones"); this.refreshFile = join(metadata, "next-refresh-at");
  }
  get recordMemoryEvidence(): ((evidence: unknown) => void) | undefined { return this.dreaming?.isEnabled() === true ? (evidence) => this.dreaming?.record(evidence) : undefined; }
  getLocation(): string { return this.dir.getLocation(); }
  setOnChange(changeListener?: (() => void) | null): void { this.dir.setOnChange(changeListener); }
  private readText(path: string): string { try { return readFileSync(path, "utf8"); } catch { return ""; } }
  private logFilePaths(): string[] { try { return readdirSync(this.logDir).filter((fileName) => fileName.endsWith(".md")).sort().map((fileName) => join(this.logDir, fileName)); } catch { return []; } }
  private logFileForTime(createdAt: number): string { return join(this.logDir, `${formatMemoryDate(createdAt).slice(0, 7)}.md`); }
  private originFilePath(content: string, origin: Exclude<MemoryOrigin, "legacy">): string { return join(origin === "explicit" ? this.explicitDir : this.generatedDir, `${memoryIdFor(content)}.memory`); }
  private tombstoneFilePath(content: string): string { return join(this.tombstoneDir, `${memoryIdFor(content)}.deleted`); }
  private isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }
  private originOf(content: string): MemoryOrigin { if (this.isFile(this.originFilePath(content, "explicit"))) return "explicit"; if (this.isFile(this.originFilePath(content, "synthesis"))) return "synthesis"; return "legacy"; }
  private writeOrigin(content: string, origin: Exclude<MemoryOrigin, "legacy">): void { this.dir.writeFileAtomic(this.originFilePath(content, origin), ""); }
  private removeOrigins(content: string): void { rmSync(this.originFilePath(content, "explicit"), { force: true }); rmSync(this.originFilePath(content, "synthesis"), { force: true }); }
  private hasTombstone(content: string): boolean { return this.isFile(this.tombstoneFilePath(content)); }
  private writeTombstone(content: string): void { this.dir.writeFileAtomic(this.tombstoneFilePath(content), ""); }
  private removeTombstone(content: string): void { rmSync(this.tombstoneFilePath(content), { force: true }); }
  private facts(): MemoryFact[] {
    const profile = parseFacts(this.readText(this.profileFile), "profile", this.profileFile);
    const logs: MemoryFact[] = []; for (const path of this.logFilePaths()) logs.push(...parseFacts(this.readText(path), "log", path, logs.length));
    return [...profile, ...logs].map((rememberedFact) => ({ ...rememberedFact, origin: this.originOf(rememberedFact.content) }));
  }
  private toRecord(rememberedFact: MemoryFact): MemoryRecord { return { id: rememberedFact.id, content: rememberedFact.content, createdAt: rememberedFact.createdAt, kind: rememberedFact.kind }; }
  private compareRecent(a: MemoryFact, b: MemoryFact): number { return b.createdAt - a.createdAt || b.order - a.order; }
  recall(recentLimit = 20): { profile: MemoryRecord[]; recent: MemoryRecord[] } { const facts = this.facts(); return { profile: facts.filter((rememberedFact) => rememberedFact.kind === "profile").sort((left, right) => this.compareRecent(left, right)).slice(0, MEMORY_PROFILE_PROMPT_LIMIT).map((rememberedFact) => this.toRecord(rememberedFact)), recent: facts.filter((rememberedFact) => rememberedFact.kind === "log").sort((left, right) => this.compareRecent(left, right)).slice(0, Math.max(0, Math.floor(recentLimit))).map((rememberedFact) => this.toRecord(rememberedFact)) }; }
  listMemories(limit = 100): MemoryRecord[] { return this.facts().sort((left, right) => Number(right.kind === "profile") - Number(left.kind === "profile") || this.compareRecent(left, right)).slice(0, Math.max(0, Math.floor(limit))).map((rememberedFact) => this.toRecord(rememberedFact)); }
  countMemories(): number { return this.facts().length; }
  addMemory(content: string, createdAt: number, kind: MemoryKind): MemoryRecord | null {
    const normalized = normalizeMemoryContent(content); if (!normalized) return null;
    const duplicate = this.facts().find((rememberedFact) => memoryDedupeKey(rememberedFact.content) === memoryDedupeKey(normalized));
    if (duplicate != null) { if (this.dreaming?.isEnabled()) { this.removeTombstone(duplicate.content); this.removeOrigins(duplicate.content); this.writeOrigin(duplicate.content, "explicit"); } return null; }
    const path = kind === "profile" ? this.profileFile : this.logFileForTime(createdAt), sourceText = this.readText(path), base = sourceText || (kind === "profile" ? PROFILE_HEADER : LOG_HEADER);
    this.dir.writeFileAtomic(path, `${base}${base.endsWith("\n") ? "" : "\n"}${serializeFactLine(normalized, createdAt)}\n`);
    if (this.dreaming?.isEnabled()) { this.removeTombstone(normalized); this.removeOrigins(normalized); this.writeOrigin(normalized, "explicit"); }
    return { id: memoryIdFor(normalized), content: normalized, createdAt, kind };
  }
  removeMemoryByContent(content: string): boolean { const normalized = normalizeMemoryContent(content); return normalized ? this.removeMemory(memoryIdFor(normalized)) : false; }
  removeMemory(id: string): boolean {
    for (const rememberedFact of this.facts()) {
      if (rememberedFact.id !== id) continue; const sourceText = this.readText(rememberedFact.path), fileLines = sourceText.split("\n"); fileLines.splice(rememberedFact.line, 1); this.dir.writeFileAtomic(rememberedFact.path, fileLines.join("\n"));
      if (this.dreaming?.isEnabled()) { this.removeOrigins(rememberedFact.content); this.writeTombstone(rememberedFact.content); }
      return true;
    }
    return false;
  }
  prepareSynthesis(): SynthesisSnapshot {
    const synthesisState = this.readState(), seenIds = new Set<string>();
    const memories = [...synthesisState.facts].sort((left, right) => Number(right.origin === "explicit") - Number(left.origin === "explicit") || Number(right.kind === "profile") - Number(left.kind === "profile") || this.compareRecent(left, right)).filter((rememberedFact) => { if (seenIds.has(rememberedFact.id)) return false; seenIds.add(rememberedFact.id); return true; }).slice(0, MEMORY_SYNTHESIS_INPUT_LIMIT).map(({ id, content, createdAt, kind, origin }) => ({ id, content, createdAt, kind, origin }));
    return { fingerprint: synthesisState.fingerprint, memories };
  }
  applySynthesis(snapshot: SynthesisSnapshot, changes: readonly SynthesisChange[], now: number): "committed" | "stale" | "invalid" {
    const synthesisState = this.readState(); if (synthesisState.fingerprint !== snapshot.fingerprint) return "stale";
    const allowedIds = new Set(snapshot.memories.map((memory) => memory.id)), byId = new Map(synthesisState.facts.map((rememberedFact) => [rememberedFact.id, rememberedFact])), changedIds = new Set<string>();
    for (const synthesisChange of changes) {
      if (synthesisChange.action === "create") { const content = normalizeMemoryContent(synthesisChange.content); if (!content) return "invalid"; if (!this.hasTombstone(content)) this.insertSynthesized(content, now, synthesisChange.kind); continue; }
      if (!allowedIds.has(synthesisChange.id) || changedIds.has(synthesisChange.id)) return "invalid"; const currentFact = byId.get(synthesisChange.id); if (currentFact == null || currentFact.origin === "explicit") return "invalid"; changedIds.add(synthesisChange.id);
      if (synthesisChange.action === "remove") { this.dropFact(currentFact, false); continue; }
      const content = normalizeMemoryContent(synthesisChange.content); if (!content) return "invalid"; this.dropFact(currentFact, false); if (!this.hasTombstone(content)) this.insertSynthesized(content, now, synthesisChange.kind);
    }
    this.markTemporalReview(now); return "committed";
  }
  private dropFact(rememberedFact: MemoryFact, tombstone: boolean): void { const fileLines = this.readText(rememberedFact.path).split("\n"); fileLines.splice(rememberedFact.line, 1); this.dir.writeFileAtomic(rememberedFact.path, fileLines.join("\n")); this.removeOrigins(rememberedFact.content); if (tombstone) this.writeTombstone(rememberedFact.content); }
  private insertSynthesized(content: string, createdAt: number, kind: MemoryKind): void { if (this.facts().some((rememberedFact) => memoryDedupeKey(rememberedFact.content) === memoryDedupeKey(content))) return; const path = kind === "profile" ? this.profileFile : this.logFileForTime(createdAt), sourceText = this.readText(path), base = sourceText || (kind === "profile" ? PROFILE_HEADER : LOG_HEADER); this.dir.writeFileAtomic(path, `${base}${base.endsWith("\n") ? "" : "\n"}${serializeFactLine(content, createdAt)}\n`); this.removeOrigins(content); this.writeOrigin(content, "synthesis"); }
  hasMemories(): boolean { return this.countMemories() > 0; }
  isTemporalReviewDue(now: number): boolean { const next = Number.parseInt(this.readText(this.refreshFile).trim(), 10); return !Number.isFinite(next) || next <= now; }
  markTemporalReview(now: number): void { this.dir.writeFileAtomic(this.refreshFile, `${now + MEMORY_SYNTHESIS_REFRESH_INTERVAL_MS}\n`); }
  clearMemories(): void { const facts = this.facts(); if (!facts.length) return; if (this.dreaming?.isEnabled()) for (const rememberedFact of facts) { this.removeOrigins(rememberedFact.content); this.writeTombstone(rememberedFact.content); } rmSync(this.logDir, { recursive: true, force: true }); this.dir.writeFileAtomic(this.profileFile, PROFILE_HEADER); }
  private readState(): { fingerprint: string; facts: MemoryFact[] } { const files = [{ path: this.profileFile, raw: this.readText(this.profileFile), kind: "profile" as const }, ...this.logFilePaths().map((path) => ({ path, raw: this.readText(path), kind: "log" as const }))], contentHash = createHash("sha256"), facts: MemoryFact[] = []; for (const stateFile of files) { contentHash.update(stateFile.path).update("\0").update(stateFile.raw).update("\0"); facts.push(...parseFacts(stateFile.raw, stateFile.kind, stateFile.path, facts.length).map((rememberedFact) => ({ ...rememberedFact, origin: this.originOf(rememberedFact.content) }))); } return { fingerprint: contentHash.digest("hex"), facts }; }
}

export function getUserMemoryDir(slateRoot: string): string { return join(slateRoot, "user-memory"); }
export function getUserMemoryShardsDir(slateRoot: string): string { return join(getUserMemoryDir(slateRoot), "agents"); }
export function getUserMemoryShardDir(slateRoot: string, agentId: string): string { return join(getUserMemoryShardsDir(slateRoot), agentId); }
export function getProjectsRootDir(slateRoot: string): string { return join(slateRoot, "projects"); }
export function getProjectDir(slateRoot: string, slug: string): string { return join(getProjectsRootDir(slateRoot), slug); }
export function getProjectMemoryShardsDir(slateRoot: string, slug: string): string { return join(getProjectDir(slateRoot, slug), "memory", "agents"); }
export function getProjectMemoryShardDir(slateRoot: string, slug: string, agentId: string): string { return join(getProjectMemoryShardsDir(slateRoot, slug), agentId); }
export function projectDirExists(slateRoot: string, slug: string): boolean { try { return statSync(getProjectDir(slateRoot, slug)).isDirectory(); } catch { return false; } }

export class UserMemoryStore {
  constructor(readonly slateRoot: string, readonly ownAgentId: string, readonly resolveAgentName: (id: string) => string, readonly debounce: DebouncePolicy) {}
  getLocation(): string { return getUserMemoryDir(this.slateRoot); }
  getOwnShardLocation(): string { return getUserMemoryShardDir(this.slateRoot, this.ownAgentId); }
  recall(limits: { profile: number; recent: number } = { profile: 50, recent: 20 }) { const profile: Array<MemoryRecord & { agentId: string; agentName: string }> = [], recent: Array<MemoryRecord & { agentId: string; agentName: string }> = []; let shardIds: string[] = []; try { shardIds = readdirSync(getUserMemoryShardsDir(this.slateRoot)); } catch {} for (const id of shardIds) { const store = new FileMemoryStore(getUserMemoryShardDir(this.slateRoot, id), this.debounce), recalledMemories = store.recall(limits.recent); profile.push(...recalledMemories.profile.map((item) => ({ ...item, agentId: id, agentName: this.resolveAgentName(id) }))); recent.push(...recalledMemories.recent.map((item) => ({ ...item, agentId: id, agentName: this.resolveAgentName(id) }))); } return { profile: profile.slice(0, limits.profile), recent: recent.sort((left, right) => right.createdAt - left.createdAt).slice(0, limits.recent) }; }
}
export class ProjectMemoryStore {
  constructor(readonly slateRoot: string, readonly ownAgentId: string, readonly membership: AgentProjectMembership, readonly resolveAgentName: (id: string) => string, readonly debounce: DebouncePolicy) {}
  getLocation(): string { return getProjectsRootDir(this.slateRoot); }
  recall(limits: { profile: number; recent: number } = { profile: 50, recent: 20 }, cap = 100) { const collected: Array<{ project: string; agentId: string; agentName: string; memory: MemoryRecord }> = []; for (const slug of this.membership.read()) { let shardIds: string[] = []; try { shardIds = readdirSync(getProjectMemoryShardsDir(this.slateRoot, slug)); } catch {} for (const id of shardIds) { const store = new FileMemoryStore(getProjectMemoryShardDir(this.slateRoot, slug, id), this.debounce), recalledMemories = store.recall(limits.recent); for (const memory of [...recalledMemories.profile, ...recalledMemories.recent]) collected.push({ project: slug, agentId: id, agentName: this.resolveAgentName(id), memory }); } } return collected.sort((a, b) => b.memory.createdAt - a.memory.createdAt).slice(0, cap); }
}

export class MemoryService {
  private activeAgentId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private synthesis: { start(): void; dispose(): void; recordTurn?(agentId: string, exchange: unknown): void } | null = null;
  constructor(readonly options: { slateRoot?: string; agentsRootDir: string; debounce: DebouncePolicy }) {}
  createAgentStore(agentDir: string): FileMemoryStore { return new FileMemoryStore(getAgentMemoryDir(agentDir), this.options.debounce, { isEnabled: () => this.synthesis != null, record: (evidence) => { const id = basename(agentDir); this.synthesis?.recordTurn?.(id, evidence); } }); }
  agentHasContent(agentDir: string): boolean { return agentMemoryHasContent(agentDir); }
  enableMemorySynthesis(service: { start(): void; dispose(): void; recordTurn?(agentId: string, exchange: unknown): void }): void { this.synthesis?.dispose(); this.synthesis = service; service.start(); }
  list({ agentId }: { agentId: string }): MemoryRecord[] { return this.storeForAgent(agentId).listMemories(); }
  remove({ agentId, id }: { agentId: string; id: string }): boolean { const removed = this.storeForAgent(agentId).removeMemory(id); if (removed) this.notify(); return removed; }
  clear({ agentId }: { agentId: string }): void { this.storeForAgent(agentId).clearMemories(); this.notify(); }
  setActiveAgent(agentId: string | null): void { if (this.activeAgentId === agentId) return; this.activeAgentId = agentId; this.notify(); }
  subscribe(changeListener: () => void): () => void { this.listeners.add(changeListener); return () => this.listeners.delete(changeListener); }
  dispose(): void { this.synthesis?.dispose(); this.synthesis = null; this.listeners.clear(); }
  synthesisTargetForAgent(agentId: string): FileMemoryStore | null { const dir = join(this.options.agentsRootDir, agentId); return existsSync(dir) ? this.createAgentStore(dir) : null; }
  listSynthesisTargets(): Array<{ agentId: string; store: FileMemoryStore }> { let shardIds: string[] = []; try { shardIds = readdirSync(this.options.agentsRootDir); } catch {} return shardIds.flatMap((agentId) => { const store = this.synthesisTargetForAgent(agentId); return store == null ? [] : [{ agentId, store }]; }); }
  storeForAgent(agentId: string): FileMemoryStore { return this.createAgentStore(join(this.options.agentsRootDir, agentId)); }
  private notify(): void { for (const changeListener of [...this.listeners]) changeListener(); }
}
