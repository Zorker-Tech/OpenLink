/**
 * The conflicts a sync finds and how they are resolved.
 *
 * A path that changed on both sides is recorded as a conflict with what each side holds, and a resolution is applied
 * once — so a store cannot end up with a path that was neither side's version.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AGENT_STORE_CONFLICT_EVENTS_FILE_NAME,
  AGENT_STORE_CONFLICT_PENDING_FILE_NAME,
  AGENT_STORE_SYNC_DIR_NAME,
  ensureSecureDirectoryChain,
} from "./paths.ts";

const CONFLICT_JOURNAL_ROTATE_BYTES = 4 * 1024 * 1024;
const MAX_DEDUP_ENTRIES = 65536;
const EVENT_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PENDING_FILE_MODE = 0o600;
const O_NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW;

export type ConflictEventKind =
  | "write_conflict"
  | "create_conflict"
  | "truncate_conflict_failed"
  | "conflict_fallback_failed"
  | "gap";

export type PendingConflictEventKind = Exclude<ConflictEventKind, "gap">;

export interface ConflictJournalEmit {
  readonly kind: PendingConflictEventKind;
  readonly storeId: string;
  readonly originalRelPath: string;
  readonly conflictRelPath?: string | undefined;
  readonly originalAbsPath: string;
  readonly conflictAbsPath?: string | undefined;
  readonly preservedBytes?: number | undefined;
  readonly source?: "local_sync" | undefined;
  readonly remoteOnly?: boolean | undefined;
}

export interface ConflictJournalEvent {
  readonly v: number;
  readonly event_id: string;
  readonly journal_epoch: string;
  readonly seq: number;
  readonly ts_ms: number;
  readonly kind: ConflictEventKind;
  readonly store_id?: string | undefined;
  readonly original_rel_path?: string | undefined;
  readonly conflict_rel_path?: string | undefined;
  readonly original_abs_path?: string | undefined;
  readonly conflict_abs_path?: string | undefined;
  readonly preserved_bytes?: number | undefined;
  readonly source?: "local_sync" | undefined;
  readonly remote_only?: boolean | undefined;
}

export interface ConflictJournalWarningOptions {
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}

function sanitizeConflictJournalWarnError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? "<redacted>" : error;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const redacted = new Error(code !== undefined ? `${error.name}: ${code}` : error.name);
  redacted.name = error.name;
  if (code !== undefined) {
    Object.defineProperty(redacted, "code", { value: code, enumerable: true, configurable: true, writable: true });
  }
  return redacted;
}

function wrapConflictJournalWarn(warner: (message: string, error: unknown) => void): (message: string, error: unknown) => void {
  return (message, error) => {
    warner(message, sanitizeConflictJournalWarnError(error));
  };
}

function nowMs(): number {
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const KNOWN_KINDS = new Set<ConflictEventKind>([
  "write_conflict",
  "create_conflict",
  "truncate_conflict_failed",
  "conflict_fallback_failed",
  "gap",
]);

function parseConflictEvent(raw: unknown): ConflictJournalEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const eventKey = asString(raw.event_id);
  const journalEpoch = asString(raw.journal_epoch);
  const kindText = asString(raw.kind);
  const seq = asNumber(raw.seq);
  const tsMs = asNumber(raw.ts_ms);
  const version = asNumber(raw.v);
  if (eventKey === undefined || journalEpoch === undefined || kindText === undefined || seq === undefined || tsMs === undefined || version === undefined || !KNOWN_KINDS.has(kindText as ConflictEventKind)) {
    return undefined;
  }
  const kind = kindText as ConflictEventKind;
  const sourceText = asString(raw.source);
  const source = sourceText === "local_sync" ? "local_sync" : undefined;
  const remoteOnly = asBoolean(raw.remote_only);
  return {
    v: version,
    event_id: eventKey,
    journal_epoch: journalEpoch,
    seq,
    ts_ms: tsMs,
    kind,
    store_id: asString(raw.store_id),
    original_rel_path: asString(raw.original_rel_path),
    conflict_rel_path: asString(raw.conflict_rel_path),
    original_abs_path: asString(raw.original_abs_path),
    conflict_abs_path: asString(raw.conflict_abs_path),
    preserved_bytes: asNumber(raw.preserved_bytes),
    ...(source === undefined ? {} : { source }),
    ...(remoteOnly === true ? { remote_only: true } : {}),
  };
}

function parseConflictJournalLines(contents: string): ConflictJournalEvent[] {
  const events: ConflictJournalEvent[] = [];
  for (const rawLine of contents.split("\n")) {
    const stripped = rawLine.trim();
    if (stripped.length === 0) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(stripped) as unknown;
    } catch {
      continue;
    }
    const journalEvent = parseConflictEvent(decoded);
    if (journalEvent !== undefined) {
      events.push(journalEvent);
    }
  }
  return events;
}

function eventToJsonLine(journalEvent: ConflictJournalEvent): string {
  const payloadRow: Record<string, unknown> = {
    v: journalEvent.v,
    event_id: journalEvent.event_id,
    journal_epoch: journalEvent.journal_epoch,
    seq: journalEvent.seq,
    ts_ms: journalEvent.ts_ms,
    kind: journalEvent.kind,
  };
  if (journalEvent.store_id !== undefined) payloadRow.store_id = journalEvent.store_id;
  if (journalEvent.original_rel_path !== undefined) payloadRow.original_rel_path = journalEvent.original_rel_path;
  if (journalEvent.conflict_rel_path !== undefined) payloadRow.conflict_rel_path = journalEvent.conflict_rel_path;
  if (journalEvent.original_abs_path !== undefined) payloadRow.original_abs_path = journalEvent.original_abs_path;
  if (journalEvent.conflict_abs_path !== undefined) payloadRow.conflict_abs_path = journalEvent.conflict_abs_path;
  if (journalEvent.preserved_bytes !== undefined) payloadRow.preserved_bytes = journalEvent.preserved_bytes;
  if (journalEvent.source !== undefined) payloadRow.source = journalEvent.source;
  if (journalEvent.remote_only === true) payloadRow.remote_only = true;
  return `${JSON.stringify(payloadRow)}\n`;
}

function dedupKeyFor(entry: ConflictJournalEmit): string | undefined {
  if (entry.conflictRelPath !== undefined) return `${entry.storeId}\0${entry.conflictRelPath}`;
  if (entry.kind === "truncate_conflict_failed") return `${entry.storeId}\0\0truncate:${entry.originalRelPath}`;
  if (entry.kind === "conflict_fallback_failed") return `${entry.storeId}\0\0fallback:${entry.originalRelPath}`;
  return undefined;
}

function dedupKeyForEvent(journalEvent: ConflictJournalEvent): string | undefined {
  if (journalEvent.store_id === undefined) return undefined;
  if (journalEvent.conflict_rel_path !== undefined) return `${journalEvent.store_id}\0${journalEvent.conflict_rel_path}`;
  if (journalEvent.original_rel_path === undefined) return undefined;
  if (journalEvent.kind === "truncate_conflict_failed") return `${journalEvent.store_id}\0\0truncate:${journalEvent.original_rel_path}`;
  if (journalEvent.kind === "conflict_fallback_failed") return `${journalEvent.store_id}\0\0fallback:${journalEvent.original_rel_path}`;
  return undefined;
}

function pendingConflictEmitKey(entry: ConflictJournalEmit): string {
  return [entry.storeId, entry.kind, entry.originalRelPath, entry.conflictRelPath ?? ""].join("\0");
}

const PENDING_EMIT_KINDS = new Set<PendingConflictEventKind>([
  "write_conflict",
  "create_conflict",
  "truncate_conflict_failed",
  "conflict_fallback_failed",
]);

function parsePendingConflictEmit(raw: unknown): ConflictJournalEmit | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = asString(raw.kind);
  const storeId = asString(raw.storeId);
  const originalRelPath = asString(raw.originalRelPath);
  const originalAbsPath = asString(raw.originalAbsPath);
  if (kind === undefined || storeId === undefined || originalRelPath === undefined || originalAbsPath === undefined || !PENDING_EMIT_KINDS.has(kind as PendingConflictEventKind)) {
    return undefined;
  }
  const sourceText = asString(raw.source);
  const remoteOnly = asBoolean(raw.remoteOnly);
  return {
    kind: kind as PendingConflictEventKind,
    storeId,
    originalRelPath,
    conflictRelPath: asString(raw.conflictRelPath),
    originalAbsPath,
    conflictAbsPath: asString(raw.conflictAbsPath),
    preservedBytes: asNumber(raw.preservedBytes),
    ...(sourceText === "local_sync" ? { source: "local_sync" } : {}),
    ...(remoteOnly === true ? { remoteOnly: true } : {}),
  };
}

function pendingEmitToJsonLine(entry: ConflictJournalEmit): string {
  const payloadRow: Record<string, unknown> = {
    kind: entry.kind,
    storeId: entry.storeId,
    originalRelPath: entry.originalRelPath,
    originalAbsPath: entry.originalAbsPath,
  };
  if (entry.conflictRelPath !== undefined) payloadRow.conflictRelPath = entry.conflictRelPath;
  if (entry.conflictAbsPath !== undefined) payloadRow.conflictAbsPath = entry.conflictAbsPath;
  if (entry.preservedBytes !== undefined) payloadRow.preservedBytes = entry.preservedBytes;
  if (entry.source !== undefined) payloadRow.source = entry.source;
  if (entry.remoteOnly === true) payloadRow.remoteOnly = true;
  return `${JSON.stringify(payloadRow)}\n`;
}

interface OpenOptions {
  readonly baseFlags: number;
  readonly mode: number;
  readonly nofollowFlag?: number | undefined;
}

function openNoFollowSync(pathName: string, settings: OpenOptions): number {
  const { baseFlags, mode, nofollowFlag } = settings;
  if (typeof nofollowFlag === "number") return fs.openSync(pathName, baseFlags | nofollowFlag, mode);
  let statEntry: fs.Stats | undefined;
  try {
    statEntry = fs.lstatSync(pathName);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (statEntry?.isSymbolicLink() === true) {
    const loopError = new Error(`refusing to open symlinked journal path: ${pathName}`);
    Object.defineProperty(loopError, "code", { value: "ELOOP", enumerable: true, configurable: true, writable: true });
    throw loopError;
  }
  return fs.openSync(pathName, baseFlags, mode);
}

function readFileNoFollowSync(pathName: string): string {
  const handle = openNoFollowSync(pathName, { baseFlags: fs.constants.O_RDONLY, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
  try {
    return fs.readFileSync(handle, "utf8");
  } finally {
    fs.closeSync(handle);
  }
}

export class ConflictJournal {
  readonly path: string;
  private readonly journalEpoch: string;
  private readonly warner: (message: string, error: unknown) => void;
  private nextSequence = 1;
  private failedAppends = 0;
  private rotationTotal = 0;
  private readonly dedupeKeys = new Set<string>();

  constructor(journalPath: string, settings?: ConflictJournalWarningOptions) {
    this.path = journalPath;
    this.journalEpoch = randomUUID();
    this.warner = wrapConflictJournalWarn(settings?.warn ?? (() => {}));
    this.hydrateDedupFromDisk();
  }

  private hydrateDedupFromDisk(): void {
    const keySet = this.readDedupKeysFromDisk();
    if (keySet === undefined) return;
    this.replaceDedupKeys(keySet);
  }

  private readDedupKeysFromDisk(): string[] | undefined {
    let contents: string;
    try {
      contents = readFileNoFollowSync(this.path);
    } catch (error) {
      if (!isEnoent(error)) {
        this.warner("conflict journal dedup hydrate failed", error);
        return undefined;
      }
      return [];
    }
    const keySet: string[] = [];
    for (const journalEvent of parseConflictJournalLines(contents)) {
      const dedupeKey = dedupKeyForEvent(journalEvent);
      if (dedupeKey !== undefined) keySet.push(dedupeKey);
    }
    return keySet;
  }

  private replaceDedupKeys(keySet: readonly string[]): void {
    this.dedupeKeys.clear();
    for (const dedupeKey of keySet) {
      if (this.dedupeKeys.size >= MAX_DEDUP_ENTRIES) this.dedupeKeys.clear();
      this.dedupeKeys.add(dedupeKey);
    }
  }

  refreshDedupFromDisk(): boolean {
    const keySet = this.readDedupKeysFromDisk();
    if (keySet === undefined) return false;
    this.replaceDedupKeys(keySet);
    return true;
  }

  appendFailureCount(): number { return this.failedAppends; }
  rotationCount(): number { return this.rotationTotal; }

  wouldDedup(entry: ConflictJournalEmit): boolean {
    const dedupeKey = dedupKeyFor(entry);
    return dedupeKey !== undefined && this.dedupeKeys.has(dedupeKey);
  }

  emit(entry: ConflictJournalEmit): boolean {
    const dedupeKey = dedupKeyFor(entry);
    if (dedupeKey !== undefined && this.dedupeKeys.has(dedupeKey)) return true;
    try {
      this.appendEmit(entry, dedupeKey);
      return true;
    } catch (error) {
      this.failedAppends += 1;
      this.warner(`conflict journal append failed; sync round still succeeded (failures=${this.failedAppends})`, error);
      return false;
    }
  }

  private appendEmit(entry: ConflictJournalEmit, dedupeKey: string | undefined): void {
    if (dedupeKey !== undefined && this.dedupeKeys.has(dedupeKey)) return;
    const parent = path.dirname(this.path);
    if (parent.length > 0) ensureSecureDirectoryChain(parent);
    this.maybeRotateLocked();
    const seq = this.nextSequence;
    const journalEvent: ConflictJournalEvent = {
      v: EVENT_SCHEMA_VERSION,
      event_id: randomUUID(),
      journal_epoch: this.journalEpoch,
      seq,
      ts_ms: nowMs(),
      kind: entry.kind,
      store_id: entry.storeId,
      original_rel_path: entry.originalRelPath,
      conflict_rel_path: entry.conflictRelPath,
      original_abs_path: entry.originalAbsPath,
      conflict_abs_path: entry.conflictAbsPath,
      preserved_bytes: entry.preservedBytes,
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.remoteOnly === true ? { remote_only: true } : {}),
    };
    this.writeJsonlLine(journalEvent);
    this.nextSequence = seq + 1;
    if (dedupeKey !== undefined) {
      if (this.dedupeKeys.size >= MAX_DEDUP_ENTRIES) this.dedupeKeys.clear();
      this.dedupeKeys.add(dedupeKey);
    }
  }

  private writeJsonlLine(journalEvent: ConflictJournalEvent): void {
    const handle = openNoFollowSync(this.path, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(handle, PRIVATE_FILE_MODE); } catch {}
      fs.writeSync(handle, eventToJsonLine(journalEvent));
      try { fs.fsyncSync(handle); } catch {}
    } finally {
      fs.closeSync(handle);
    }
  }

  private maybeRotateLocked(): void {
    let journalBytes: number;
    try {
      journalBytes = fs.statSync(this.path).size;
    } catch (error) {
      if (isEnoent(error)) return;
      this.warner("conflict journal metadata failed; skipping rotate", error);
      return;
    }
    if (journalBytes < CONFLICT_JOURNAL_ROTATE_BYTES) return;
    try {
      this.forceGapRewriteLocked();
    } catch (error) {
      this.warner("conflict journal rotate rewrite failed; appending onto oversized journal", error);
    }
  }

  private forceGapRewriteLocked(): void {
    const seq = this.nextSequence;
    const gap: ConflictJournalEvent = {
      v: EVENT_SCHEMA_VERSION,
      event_id: randomUUID(),
      journal_epoch: this.journalEpoch,
      seq,
      ts_ms: nowMs(),
      kind: "gap",
    };
    const tempFile = `${this.path}.rotate-tempFile`;
    try {
      fs.unlinkSync(tempFile);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const handle = openNoFollowSync(tempFile, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode: PRIVATE_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(handle, PRIVATE_FILE_MODE); } catch {}
      fs.writeSync(handle, eventToJsonLine(gap));
      try { fs.fsyncSync(handle); } catch {}
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempFile, this.path);
    this.nextSequence = seq + 1;
    this.dedupeKeys.clear();
    this.rotationTotal += 1;
  }
}

export function conflictJournalPathForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_EVENTS_FILE_NAME);
}

export function conflictPendingJournalPathForFilesDir(filesDir: string): string {
  return path.join(path.dirname(path.resolve(filesDir)), AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_PENDING_FILE_NAME);
}

interface PendingDiskState {
  readonly queued: ConflictJournalEmit[];
  readonly keySet: Set<string>;
}

export class PendingConflictJournal {
  readonly path: string;
  private readonly warner: (message: string, error: unknown) => void;
  private queued: ConflictJournalEmit[] = [];
  private keySet = new Set<string>();
  private failedPersists = 0;
  private needsPersist = false;
  private loadBroken = false;

  constructor(pendingPath: string, settings?: ConflictJournalWarningOptions) {
    this.path = pendingPath;
    this.warner = wrapConflictJournalWarn(settings?.warn ?? (() => {}));
    const diskState = this.tryReadDisk();
    if (diskState !== undefined) {
      this.queued = diskState.queued;
      this.keySet = diskState.keySet;
    } else {
      this.loadBroken = true;
    }
  }

  size(): number { return this.queued.length; }
  isEmpty(): boolean { return this.queued.length === 0; }
  list(): ConflictJournalEmit[] { return [...this.queued]; }
  persistFailureCount(): number { return this.failedPersists; }

  reload(): void {
    const diskState = this.tryReadDisk();
    if (diskState === undefined) return;
    this.loadBroken = false;
    if (!this.needsPersist) {
      this.queued = diskState.queued;
      this.keySet = diskState.keySet;
      return;
    }
    const mergedByKey = new Map<string, ConflictJournalEmit>();
    for (const entry of diskState.queued) mergedByKey.set(pendingConflictEmitKey(entry), entry);
    for (const entry of this.queued) mergedByKey.set(pendingConflictEmitKey(entry), entry);
    const mergedEntries = [...mergedByKey.values()];
    this.queued = mergedEntries;
    this.keySet = new Set(mergedByKey.keys());
    this.needsPersist = !this.persistPending(mergedEntries);
  }

  enqueue(entry: ConflictJournalEmit): void {
    const dedupeKey = pendingConflictEmitKey(entry);
    if (this.keySet.has(dedupeKey)) {
      if (this.needsPersist || this.loadBroken) this.needsPersist = !this.persistPending(this.queued);
      return;
    }
    this.keySet.add(dedupeKey);
    this.queued.push(entry);
    this.needsPersist = !this.persistPending(this.queued);
  }

  replaceAll(emits: readonly ConflictJournalEmit[]): void {
    const next: ConflictJournalEmit[] = [];
    const nextKeys = new Set<string>();
    for (const entry of emits) {
      const dedupeKey = pendingConflictEmitKey(entry);
      if (nextKeys.has(dedupeKey)) continue;
      nextKeys.add(dedupeKey);
      next.push(entry);
    }
    const recoveringLoad = this.loadBroken;
    if (this.persistPending(next)) {
      if (!recoveringLoad) {
        this.queued = next;
        this.keySet = nextKeys;
      }
      this.needsPersist = false;
    }
  }

  private tryReadDisk(): PendingDiskState | undefined {
    let contents: string;
    try {
      contents = readFileNoFollowSync(this.path);
    } catch (error) {
      if (isEnoent(error)) return { queued: [], keySet: new Set() };
      this.warner("conflict pending journal load failed", error);
      return undefined;
    }
    const queued: ConflictJournalEmit[] = [];
    const keySet = new Set<string>();
    for (const rawLine of contents.split("\n")) {
      const stripped = rawLine.trim();
      if (stripped.length === 0) continue;
      let decoded: unknown;
      try { decoded = JSON.parse(stripped) as unknown; } catch { continue; }
      const entry = parsePendingConflictEmit(decoded);
      if (entry === undefined) continue;
      const dedupeKey = pendingConflictEmitKey(entry);
      if (keySet.has(dedupeKey)) continue;
      keySet.add(dedupeKey);
      queued.push(entry);
    }
    return { queued, keySet };
  }

  private persistPending(queued: readonly ConflictJournalEmit[]): boolean {
    if (this.loadBroken) {
      const diskState = this.tryReadDisk();
      if (diskState === undefined) {
        this.failedPersists += 1;
        this.warner(`conflict pending journal persist skipped; sidecar still unreadable (failures=${this.failedPersists})`, undefined);
        return false;
      }
      this.loadBroken = false;
      const mergedByKey = new Map<string, ConflictJournalEmit>();
      for (const entry of diskState.queued) mergedByKey.set(pendingConflictEmitKey(entry), entry);
      for (const entry of queued) mergedByKey.set(pendingConflictEmitKey(entry), entry);
      const mergedEntries = [...mergedByKey.values()];
      this.queued = mergedEntries;
      this.keySet = new Set(mergedByKey.keys());
      return this.persistPending(mergedEntries);
    }
    try {
      if (queued.length === 0) {
        this.removeFile();
        return true;
      }
      const parent = path.dirname(this.path);
      if (parent.length > 0) ensureSecureDirectoryChain(parent);
      this.atomicRewrite(queued.map(pendingEmitToJsonLine).join(""));
      return true;
    } catch (error) {
      this.failedPersists += 1;
      this.warner(`conflict pending journal persist failed (failures=${this.failedPersists})`, error);
      return false;
    }
  }

  private atomicRewrite(contents: string): void {
    const tempFile = `${this.path}.queued-tempFile`;
    try {
      fs.unlinkSync(tempFile);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const handle = openNoFollowSync(tempFile, { baseFlags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode: PENDING_FILE_MODE, nofollowFlag: O_NOFOLLOW_FLAG });
    try {
      try { fs.fchmodSync(handle, PENDING_FILE_MODE); } catch {}
      fs.writeSync(handle, contents);
      try { fs.fsyncSync(handle); } catch {}
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tempFile, this.path);
  }

  private removeFile(): void {
    try {
      fs.unlinkSync(this.path);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
