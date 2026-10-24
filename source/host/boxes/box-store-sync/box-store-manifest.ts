/**
 * The box store's manifest: what the box holds, in one document, and the revision that says whether writing it is worth
 * anything.
 *
 * The manifest is the store's index: a path in the box maps to a hash (and, in v2, a kind and a mode), and the store's
 * blobs are named by those hashes. Three rules shape this file:
 *
 * - **a write happens only when it would change something** — the revision state remembers what was persistedBaseline and what is
 *   already in flight, so a cycle that found nothing is free rather than an upload of an identical document;
 * - **a lost race is not a failure** — the object store is written by more than one host, so a conflict is reported with
 *   what the winner wrote, and a caller that asked to accept a matching canonicalManifest manifest gets it;
 * - **the manifest can be unreadable without being broken** — a conflicting node path (a file and a directory with the
 *   same name) blocks writing and is reported by name, because a silently lossy manifest would delete files later.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import type { RetryPolicy } from "../../extensions/scheduling.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { invariant } from "../../../shared/invariant.ts";
import {
  BOX_STORE_LEGACY_MANIFEST_VERSION,
  BOX_STORE_MANIFEST_REL_PATH,
  BOX_STORE_MANIFEST_VERSION,
  boxStoreManifestEntriesEqual,
  isSymlinkManifestValue,
  manifestSchema,
  type BoxStoreManifestEntry,
} from "./box-store-manifest-format.ts";
import { isHydrationHandoffManifestPath, removeHydrationHandoffMarker, writeHydrationHandoffMarker } from "./box-store-hydration.ts";
import type { BoxObjectStoreProvider } from "./box-object-store.ts";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";
import type { StoreDbCaptureTrace } from "./store-db-bundle-capture.ts";

/** The files that make up one agent's store: both are captured as a unit, never piecemeal. */
export const AGENT_STORE_DB_BASENAMES = ["store.db", "conversation-blobs.db"] as const;
export const STORE_DB_MANIFEST_KEY_RE = /^home\/box\/slate-data\/agents\/([^/]+)\/store\.db$/;
export const AGENT_DIR_MANIFEST_KEY_RE = /^home\/box\/slate-data\/agents\/([^/]+)\//;
export type BoxManifestMap = Map<string, BoxStoreManifestEntry>;

export function countStoreDbManifestEntries(manifest: ReadonlyMap<string, unknown> | null | undefined): number {
  if (manifest == null) return 0;
  let count = 0;
  for (const [relPath, entry] of manifest) if (STORE_DB_MANIFEST_KEY_RE.test(relPath) && !isSymlinkManifestValue(entry)) count += 1;
  return count;
}

/** The agents whose store the manifest covers: a symlink never stands in for one. */
export function getStoreDbManifestAgentIds(manifest: ReadonlyMap<string, unknown> | null): Set<string> {
  const agentIds = new Set<string>();
  for (const [relPath, entry] of manifest ?? []) {
    const match = STORE_DB_MANIFEST_KEY_RE.exec(relPath);
    if (match?.[1] != null && !isSymlinkManifestValue(entry)) agentIds.add(match[1]);
  }
  return agentIds;
}

export function countAgentDirManifestEntries(manifest: ReadonlyMap<string, unknown> | null | undefined): number {
  if (manifest == null) return 0;
  const ids = new Set<string>();
  for (const relPath of manifest.keys()) {
    const match = AGENT_DIR_MANIFEST_KEY_RE.exec(relPath);
    if (match != null) ids.add(match[1]!);
  }
  return ids.size;
}

function parseWireJson(wireBytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(wireBytes).toString("utf8"));
}

const manifestVersionSchema = z.object({ version: z.number().int() });

export class BoxStoreUnsupportedManifestVersionError extends BoxStoreSyncError {
  constructor(readonly version: number) {
    super(`unsupported box store manifest version ${version}`);
  }
}

export class BoxStoreManifestPathConflictError extends BoxStoreSyncError {
  constructor() {
    super("box store manifest contains conflicting node paths");
  }
}

function ancestorPaths(relPath: string): string[] {
  const ancestors: string[] = [];
  for (let separatorIndex = relPath.indexOf("/"); separatorIndex >= 0; separatorIndex = relPath.indexOf("/", separatorIndex + 1)) {
    ancestors.push(relPath.slice(0, separatorIndex));
  }
  return ancestors;
}

/** Whether one entry's path is also another entry's parent: a manifest cannot hold both, so it is refused. */
export function hasManifestPathConflict(entries: Record<string, unknown>): boolean {
  const relPaths = new Set(Object.keys(entries));
  for (const relPath of relPaths) if (ancestorPaths(relPath).some((ancestor) => relPaths.has(ancestor))) return true;
  return false;
}

export type DecodedManifest = z.infer<typeof manifestSchema>;

/**
 * A manifest read from wireBytes, or null when it is not a manifest at all. A version this build does not know, or a set of
 * conflicting paths, is not "unreadable": both are thrown and reported to the caller's write-block sink.
 */
export function parseManifest(wireBytes: Uint8Array, onWriteBlockedError?: (error: Error) => void): DecodedManifest | null {
  let value: unknown;
  try {
    value = parseWireJson(wireBytes);
  } catch {
    return null;
  }
  const header = manifestVersionSchema.safeParse(value);
  if (header.success && header.data.version !== BOX_STORE_LEGACY_MANIFEST_VERSION && header.data.version !== BOX_STORE_MANIFEST_VERSION) {
    const error = new BoxStoreUnsupportedManifestVersionError(header.data.version);
    onWriteBlockedError?.(error);
    throw error;
  }
  const decodedManifest = manifestSchema.safeParse(value);
  if (!decodedManifest.success) return null;
  if (hasManifestPathConflict(decodedManifest.data.entries)) {
    const error = new BoxStoreManifestPathConflictError();
    onWriteBlockedError?.(error);
    throw error;
  }
  return decodedManifest.data;
}

interface ManifestCapture {
  revision: number;
  entries: Record<string, BoxStoreManifestEntry>;
}

/**
 * Which revision of the manifest is in memory, which one is on the store, and how many writes for a revision are in
 * flight. A capture is the decision to write; a release is the write finishing (successfully or not).
 */
export class BoxStoreManifestRevisionState {
  private revisionCounter = 0;
  private readonly pendingWritesByRevision = new Map<number, number>();
  private captureCount = 0;
  constructor(private persistedBaseline?: { revision: number; fullyHydrated?: boolean | undefined }) {}

  get revision(): number {
    return this.revisionCounter;
  }

  get persistedRevision(): number | undefined {
    return this.persistedBaseline?.revision;
  }

  get snapshotConstructionCount(): number {
    return this.captureCount;
  }

  get hasPendingWriteForRevision(): boolean {
    return (this.pendingWritesByRevision.get(this.revisionCounter) ?? 0) > 0;
  }

  markChanged(): void {
    this.revisionCounter += 1;
  }

  /** A write is captured unless nothing changed since the store last saw this revision, and nothing is already in flight. */
  capture(manifest: ReadonlyMap<string, BoxStoreManifestEntry>, fullyHydrated: boolean | undefined, requiresWrite: boolean): ManifestCapture | null {
    const alreadyWriting = (this.pendingWritesByRevision.get(this.revisionCounter) ?? 0) > 0;
    const storeHasThisRevision = this.persistedBaseline?.revision === this.revisionCounter && this.persistedBaseline.fullyHydrated === fullyHydrated;
    if (!requiresWrite && (alreadyWriting || storeHasThisRevision)) return null;
    const entries: Record<string, BoxStoreManifestEntry> = {};
    for (const [relPath, entry] of manifest) entries[relPath] = entry;
    this.captureCount += 1;
    this.pendingWritesByRevision.set(this.revisionCounter, (this.pendingWritesByRevision.get(this.revisionCounter) ?? 0) + 1);
    return { revision: this.revisionCounter, entries };
  }

  markPersisted(capture: ManifestCapture, fullyHydrated: boolean | undefined): void {
    this.persistedBaseline = { revision: capture.revision, fullyHydrated };
  }

  /** A failed write forgets what the store is believed to hold, so the next capture is a real one. */
  markFailed(): void {
    this.persistedBaseline = undefined;
  }

  release(capture: ManifestCapture): void {
    const count = this.pendingWritesByRevision.get(capture.revision);
    if (count == null || count <= 1) this.pendingWritesByRevision.delete(capture.revision);
    else this.pendingWritesByRevision.set(capture.revision, count - 1);
  }
}

export class ManifestRetryStoppedError extends Error {
  constructor(readonly conflict: BoxStoreCanonicalWriteConflictError) {
    super(conflict.message);
    this.name = "ManifestRetryStoppedError";
  }
}

export interface ManifestStoreDependencies {
  objectStoreProvider: BoxObjectStoreProvider;
  resolveStoreId(): Promise<string>;
  manifestRetry: RetryPolicy;
  manifestV2: boolean;
  windowId?: string;
  hydrationHandoffMarkerPath?: string;
  onManifestWriteConflict?(conflictInfo: Record<string, unknown>): void;
}

export interface ManifestSaveOptions {
  acceptMatchingCanonicalOnConflict?: boolean;
  isForced?: boolean;
  hydrationUpdate?: "mark-incomplete" | "promote-complete" | "reset-complete" | undefined;
  captureTrace?: StoreDbCaptureTrace | undefined;
}

/** The manifest document, its revision, and the writes queued behind each other. */
export class BoxStoreManifestStore {
  private manifestV2Enabled: boolean;
  manifest: BoxManifestMap | undefined;
  private readonly revisionStates = new WeakMap<BoxManifestMap, BoxStoreManifestRevisionState>();
  private readonly ancestorCountsByManifest = new WeakMap<BoxManifestMap, Map<string, number>>();
  fullyHydrated: boolean | undefined;
  hydrationManifestReadBlocked = false;
  manifestWriteBlock: Error | undefined;
  readonly uncommittedStoreDbEntries = new Map<string, BoxStoreManifestEntry>();
  private pendingWritesQueue: Promise<void> = Promise.resolve();
  private loadInFlightPromise: Promise<BoxManifestMap> | undefined;

  constructor(readonly args: { deps: ManifestStoreDependencies; now: () => number; log: (message: string) => void; isDisposed: () => boolean }) {
    this.manifestV2Enabled = args.deps.manifestV2;
  }

  get deps(): ManifestStoreDependencies {
    return this.args.deps;
  }

  get writeQueue(): Promise<void> {
    return this.pendingWritesQueue;
  }

  get isManifestV2Enabled(): boolean {
    return this.manifestV2Enabled;
  }

  /** Reads a v2 manifest once: from then on this store writes v2, because the store's own format decides. */
  enrollManifestV2(): void {
    this.manifestV2Enabled = true;
  }

  objectStore(storeId: string) {
    return this.deps.objectStoreProvider.forStore(storeId);
  }

  configuredManifestVersion(): 1 | 2 {
    return this.manifestV2Enabled ? BOX_STORE_MANIFEST_VERSION : BOX_STORE_LEGACY_MANIFEST_VERSION;
  }

  /** An entry as this store's format can hold it: a legacy manifest has no room for a symlink. */
  configuredEntry(entry: BoxStoreManifestEntry): BoxStoreManifestEntry | undefined {
    if (this.manifestV2Enabled) return entry;
    if (entry.kind === "symlink") return undefined;
    return { sha: entry.sha, size: entry.size };
  }

  configuredEntries(entries: Record<string, BoxStoreManifestEntry>): Record<string, BoxStoreManifestEntry> {
    const configured: Record<string, BoxStoreManifestEntry> = {};
    for (const [relPath, entry] of Object.entries(entries)) {
      const value = this.configuredEntry(entry);
      if (value != null) configured[relPath] = value;
    }
    return configured;
  }

  parseManifest(wireBytes: Uint8Array): DecodedManifest | null {
    const decodedManifest = parseManifest(wireBytes, (error) => {
      if (error instanceof BoxStoreUnsupportedManifestVersionError || this.manifestWriteBlock == null) this.manifestWriteBlock = error;
    });
    if (decodedManifest?.version === BOX_STORE_MANIFEST_VERSION) this.manifestV2Enabled = true;
    return decodedManifest;
  }

  manifestRevisionState(manifest: BoxManifestMap): BoxStoreManifestRevisionState {
    let state = this.revisionStates.get(manifest);
    if (state == null) {
      state = new BoxStoreManifestRevisionState();
      this.revisionStates.set(manifest, state);
    }
    return state;
  }

  initializeManifestRevision(manifest: BoxManifestMap, persistedBaseline?: { revision: number; fullyHydrated?: boolean | undefined }): void {
    this.revisionStates.set(manifest, new BoxStoreManifestRevisionState(persistedBaseline));
  }

  /** How many entries sit under each directory: the index that makes "is this a file or a directory" cheap to ask. */
  private ancestorCounts(manifest: BoxManifestMap): Map<string, number> {
    const existing = this.ancestorCountsByManifest.get(manifest);
    if (existing != null) return existing;
    const counts = new Map<string, number>();
    for (const relPath of manifest.keys()) this.updateAncestorCounts(counts, relPath, 1);
    this.ancestorCountsByManifest.set(manifest, counts);
    return counts;
  }

  private updateAncestorCounts(counts: Map<string, number>, relPath: string, delta: number): void {
    for (const ancestor of ancestorPaths(relPath)) {
      const next = (counts.get(ancestor) ?? 0) + delta;
      if (next === 0) counts.delete(ancestor);
      else counts.set(ancestor, next);
    }
  }

  private removeEntryWithIndex(manifest: BoxManifestMap, relPath: string, counts?: Map<string, number>): boolean {
    if (!manifest.delete(relPath)) return false;
    if (counts != null) this.updateAncestorCounts(counts, relPath, -1);
    this.uncommittedStoreDbEntries.delete(relPath);
    this.manifestRevisionState(manifest).markChanged();
    return true;
  }

  /**
   * Puts one path in the manifest. A path cannot be both a file and a directory, so the entry that conflicts with it —
   * its ancestor, or anything under it — is removed first, and that removal is reported to the caller as a change.
   */
  setManifestEntry(manifest: BoxManifestMap, relPath: string, entry: BoxStoreManifestEntry): boolean {
    const configured = this.configuredEntry(entry);
    if (configured == null) return this.removeEntryWithIndex(manifest, relPath, this.ancestorCountsByManifest.get(manifest));
    const counts = this.ancestorCounts(manifest);
    let removedConflict = false;
    for (const ancestor of ancestorPaths(relPath)) removedConflict = this.removeEntryWithIndex(manifest, ancestor, counts) || removedConflict;
    if ((counts.get(relPath) ?? 0) > 0) {
      for (const existingPath of manifest.keys()) {
        if (existingPath.startsWith(`${relPath}/`)) removedConflict = this.removeEntryWithIndex(manifest, existingPath, counts) || removedConflict;
      }
    }
    const current = manifest.get(relPath);
    if (boxStoreManifestEntriesEqual(current, configured)) return removedConflict;
    manifest.set(relPath, configured);
    if (current == null) this.updateAncestorCounts(counts, relPath, 1);
    this.manifestRevisionState(manifest).markChanged();
    return true;
  }

  deleteManifestEntry(manifest: BoxManifestMap, relPath: string): boolean {
    return this.removeEntryWithIndex(manifest, relPath, this.ancestorCountsByManifest.get(manifest));
  }

  private elapsedSince(startedAt: number): number {
    return Math.max(0, this.args.now() - startedAt);
  }

  private clearCommittedStoreDb(entries: Record<string, BoxStoreManifestEntry>): void {
    for (const [relPath, pending] of this.uncommittedStoreDbEntries) {
      if (boxStoreManifestEntriesEqual(entries[relPath], pending)) this.uncommittedStoreDbEntries.delete(relPath);
    }
  }

  isLiveManifest(manifest: BoxManifestMap | null | undefined): boolean {
    return manifest != null && this.manifest === manifest;
  }

  /** Whether the sweep's captures are the ones the store now holds: a liveManifestView manifest with nothing left uncommitted. */
  isStoreDbSweepCommitted(manifest: BoxManifestMap | null | undefined, capturedThisSweep: Iterable<string>): boolean {
    if (!this.isLiveManifest(manifest)) return false;
    for (const relPath of capturedThisSweep) if (this.uncommittedStoreDbEntries.has(relPath)) return false;
    return true;
  }

  /**
   * The manifest in memory, loaded once. A handoff marker that is pending makes a missing or unreadable manifest an error:
   * the previous store said it had more to carry, so starting empty would lose it.
   */
  loadManifest(storeId: string): Promise<BoxManifestMap> {
    if (this.manifestWriteBlock != null) return Promise.reject(this.manifestWriteBlock);
    if (this.manifest != null) return Promise.resolve(this.manifest);
    this.loadInFlightPromise ??= (async () => {
      try {
        const loadedManifest = new Map<string, BoxStoreManifestEntry>();
        let persistedBaseline: { revision: number; fullyHydrated?: boolean | undefined } | undefined;
        const handoffPending = this.deps.hydrationHandoffMarkerPath != null && existsSync(this.deps.hydrationHandoffMarkerPath);
        try {
          const wireBytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
          if (wireBytes == null && handoffPending) throw new BoxStoreSyncError("manifest missing while legacy hydration handoff is pending");
          if (wireBytes != null) {
            const decoded = this.parseManifest(wireBytes);
            if (decoded == null && handoffPending) throw new BoxStoreSyncError("manifest unreadable while legacy hydration handoff is pending");
            if (decoded != null) {
              if (handoffPending && decoded.fullyHydrated == null && this.deps.hydrationHandoffMarkerPath != null) {
                await removeHydrationHandoffMarker(this.deps.hydrationHandoffMarkerPath);
              }
              this.hydrationManifestReadBlocked = false;
              this.fullyHydrated = decoded.fullyHydrated;
              let canonicalSnapshot = true;
              for (const [relPath, entry] of Object.entries(decoded.entries)) {
                // The marker and its temporary are evidence, not content: they are not part of the canonicalManifest view.
                if (isHydrationHandoffManifestPath(relPath)) canonicalSnapshot = false;
                else loadedManifest.set(relPath, entry);
              }
              if (canonicalSnapshot && decoded.version === this.configuredManifestVersion()) persistedBaseline = { revision: 0, fullyHydrated: decoded.fullyHydrated };
            }
          }
        } catch (error) {
          if (error instanceof BoxStoreUnsupportedManifestVersionError || error instanceof BoxStoreManifestPathConflictError) throw error;
          if (handoffPending) {
            this.hydrationManifestReadBlocked = true;
            throw error;
          }
          this.args.log(`manifest load failed, starting empty: ${errorMessage(error)}`);
        }
        this.initializeManifestRevision(loadedManifest, persistedBaseline);
        this.manifest ??= loadedManifest;
        return this.manifest;
      } finally {
        this.loadInFlightPromise = undefined;
      }
    })();
    return this.loadInFlightPromise;
  }

  /**
   * Writes the manifest, queued behind any write already running. A capture is only made when it would say something new;
   * a required write (a forced one, a conflict-accepting one, a hydration change) is always made.
   */
  saveManifest(storeId: string, options: ManifestSaveOptions = {}): Promise<void> {
    if (this.manifestWriteBlock != null) return Promise.reject(this.manifestWriteBlock);
    if (this.hydrationManifestReadBlocked) return Promise.reject(new Error("manifest write blocked until hydration metadata can be read"));
    const manifestSnapshot = (this.manifest ??= new Map());
    const revisionState = this.manifestRevisionState(manifestSnapshot);
    const requiresWrite = options.acceptMatchingCanonicalOnConflict === true || options.isForced === true || options.hydrationUpdate != null;
    const captureTrace = options.captureTrace;
    const enqueuedAt = captureTrace == null ? undefined : this.args.now();
    const capture = revisionState.capture(manifestSnapshot, this.fullyHydrated, requiresWrite);
    if (capture == null) {
      if (!revisionState.hasPendingWriteForRevision) return Promise.resolve();
      const queuedPosition = this.pendingWritesQueue;
      if (captureTrace == null || enqueuedAt == null) return queuedPosition;
      return queuedPosition.then(() => {
        captureTrace.queueDurationMs += this.elapsedSince(enqueuedAt);
      });
    }
    const run = async () => {
      if (captureTrace != null && enqueuedAt != null) captureTrace.queueDurationMs += this.elapsedSince(enqueuedAt);
      const commitStartedAt = this.args.now();
      try {
        if (this.manifestWriteBlock != null) throw this.manifestWriteBlock;
        let fullyHydrated = this.fullyHydrated;
        if (options.hydrationUpdate === "mark-incomplete") fullyHydrated = false;
        else if (options.hydrationUpdate === "promote-complete" || options.hydrationUpdate === "reset-complete") fullyHydrated = true;
        const entries = this.configuredEntries(capture.entries);
        await this.writeManifestWithRetry(storeId, entries, fullyHydrated, options);
        revisionState.markPersisted(capture, fullyHydrated);
        this.fullyHydrated = fullyHydrated;
        this.clearCommittedStoreDb(entries);
      } catch (error) {
        revisionState.markFailed();
        throw error;
      } finally {
        if (captureTrace != null) captureTrace.manifestCommitDurationMs += this.elapsedSince(commitStartedAt);
        revisionState.release(capture);
      }
    };
    const save = this.pendingWritesQueue.then(run, run);
    this.pendingWritesQueue = save.then(
      () => {},
      () => {},
    );
    return save;
  }

  private async writeManifestWithRetry(storeId: string, entries: Record<string, BoxStoreManifestEntry>, fullyHydrated: boolean | undefined, options: ManifestSaveOptions = {}): Promise<void> {
    let attemptCount = 0;
    let lastWriteConflict: BoxStoreCanonicalWriteConflictError | undefined;
    try {
      await this.deps.manifestRetry.runWithRetry(async (attempt) => {
        // A host that is going away stops retrying: the conflict is reported rather than chased.
        if (attempt > 1 && this.args.isDisposed() && lastWriteConflict != null) throw new ManifestRetryStoppedError(lastWriteConflict);
        attemptCount = attempt;
        const manifest = { version: this.configuredManifestVersion(), updatedAtMs: this.args.now(), writerWindowId: this.deps.windowId, fullyHydrated, entries };
        try {
          await this.writeManifestAttempt(storeId, manifest);
        } catch (error) {
          if (error instanceof ManifestRetryStoppedError) lastWriteConflict = error.conflict;
          else if (error instanceof BoxStoreCanonicalWriteConflictError) lastWriteConflict = error;
          throw error;
        }
      });
      return;
    } catch (error) {
      const conflict = error instanceof ManifestRetryStoppedError ? error.conflict : error;
      if (!(conflict instanceof BoxStoreCanonicalWriteConflictError)) throw error;
      if (await this.handleExhaustedManifestConflict(storeId, entries, fullyHydrated, conflict, attemptCount, options)) return;
      throw conflict;
    }
  }

  private async writeManifestAttempt(storeId: string, manifest: object): Promise<void> {
    try {
      await this.objectStore(storeId).put(BOX_STORE_MANIFEST_REL_PATH, new Uint8Array(Buffer.from(JSON.stringify(manifest), "utf8")));
    } catch (error) {
      if (error instanceof BoxStoreCanonicalWriteConflictError && this.args.isDisposed()) throw new ManifestRetryStoppedError(error);
      if (error instanceof BoxStoreCanonicalWriteConflictError) {
        // The winner's manifest becomes the base of the next attempt, so a retry merges rather than overwrites.
        const canonicalManifest = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
        if (canonicalManifest != null) this.parseManifest(canonicalManifest);
        this.args.log(
          `manifest save lost a concurrent-write race; retry policy will use the winner's baseline${error.conflictRelPath == null ? "" : ` (lost attempt preserved at ${error.conflictRelPath})`}`,
        );
      }
      throw error;
    }
  }

  /**
   * After the retries are spent: report what happened, and accept the canonicalManifest manifest only when the caller asked for it
   * *and* that manifest already covers exactly what was attemptedEntries (nothing of this host's work would be lost).
   */
  private async handleExhaustedManifestConflict(
    storeId: string,
    entries: Record<string, BoxStoreManifestEntry>,
    fullyHydrated: boolean | undefined,
    conflict: BoxStoreCanonicalWriteConflictError,
    attemptCount: number,
    options: ManifestSaveOptions,
  ): Promise<boolean> {
    const canonicalManifest = await this.readCanonicalManifestForDiagnostics(storeId);
    const attemptedEntries = Object.entries(entries);
    const coveredByCanonical = canonicalManifest != null && attemptedEntries.length > 0 && attemptedEntries.every(([relPath, entry]) => boxStoreManifestEntriesEqual(canonicalManifest.entries[relPath], entry));
    const canonicalMatchesAttempt = coveredByCanonical && canonicalManifest != null && Object.keys(canonicalManifest.entries).length === attemptedEntries.length && canonicalManifest.fullyHydrated === fullyHydrated;
    const liveManifestView = this.manifest ?? new Map();
    const liveViewChanged = liveManifestView.size !== attemptedEntries.length || attemptedEntries.some(([relPath, entry]) => !boxStoreManifestEntriesEqual(liveManifestView.get(relPath), entry));
    const acceptCanonical = options.acceptMatchingCanonicalOnConflict === true && canonicalMatchesAttempt && !liveViewChanged;
    this.reportManifestWriteConflict({
      storeId,
      attempts: attemptCount,
      accepted: acceptCanonical,
      covered: coveredByCanonical,
      canonicalMatchesAttempt,
      liveViewChanged,
      attemptedEntries: attemptedEntries.length,
      lastBaseEtag: conflict.baseEtag,
      lastBaselineSource: conflict.baselineSource,
      lastConflictRelPath: conflict.conflictRelPath,
      canonicalReadable: canonicalManifest != null,
      canonicalEntryCount: canonicalManifest == null ? null : Object.keys(canonicalManifest.entries).length,
      canonicalUpdatedAtMs: canonicalManifest?.updatedAtMs ?? null,
      canonicalWriterWindowId: canonicalManifest?.writerWindowId ?? null,
      ourWindowId: this.deps.windowId ?? null,
    });
    if (acceptCanonical) {
      this.args.log(
        `manifest save lost a concurrent-write race; canonical manifest already covers the attempted entries (winner ${canonicalManifest?.writerWindowId ?? "unknown"}${conflict.conflictRelPath == null ? "" : `; lost attempt preserved at ${conflict.conflictRelPath}`})`,
      );
    }
    return acceptCanonical;
  }

  private async readCanonicalManifestForDiagnostics(
    storeId: string,
  ): Promise<{ entries: Record<string, BoxStoreManifestEntry>; updatedAtMs: number; writerWindowId: string | null; fullyHydrated?: boolean | undefined } | null> {
    try {
      const wireBytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
      if (wireBytes == null) return null;
      const decodedManifest = parseManifest(wireBytes);
      if (decodedManifest == null) return null;
      return { entries: decodedManifest.entries, updatedAtMs: decodedManifest.updatedAtMs, writerWindowId: decodedManifest.writerWindowId ?? null, fullyHydrated: decodedManifest.fullyHydrated };
    } catch (error) {
      this.args.log(`canonicalManifest manifest readback failed after a lost write: ${errorMessage(error)}`);
      return null;
    }
  }

  async readCanonicalManifestSnapshot(): Promise<DecodedManifest | null> {
    const storeId = await this.deps.resolveStoreId();
    const wireBytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
    return wireBytes == null ? null : this.parseManifest(wireBytes);
  }

  private reportManifestWriteConflict(conflictInfo: Record<string, unknown>): void {
    try {
      this.deps.onManifestWriteConflict?.(conflictInfo);
    } catch {
      // Reporting a conflict must not become the conflict that fails the cycle.
    }
  }

  /** Before clearing the store: a conflicting manifest is unblocked (it is about to be replaced), an unknown version is not. */
  async prepareCanonicalManifestReset(storeId: string): Promise<void> {
    const wireBytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
    if (wireBytes == null) return;
    try {
      this.parseManifest(wireBytes);
    } catch (error) {
      if (!(error instanceof BoxStoreManifestPathConflictError)) throw error;
      if (this.manifestWriteBlock instanceof BoxStoreUnsupportedManifestVersionError) throw this.manifestWriteBlock;
    }
    if (this.manifestWriteBlock instanceof BoxStoreManifestPathConflictError) this.manifestWriteBlock = undefined;
  }

  async readManifestStrict(): Promise<BoxManifestMap> {
    return (await this.readManifestStrictDetailed()).manifest;
  }

  /** The store's manifest as it is now, with no cache: a present-but-unparseable manifest is an error, not an empty store. */
  async readManifestStrictDetailed(): Promise<{ present: boolean; manifest: BoxManifestMap; fullyHydrated?: boolean | undefined }> {
    if (this.manifestWriteBlock != null) throw this.manifestWriteBlock;
    const storeId = await this.deps.resolveStoreId();
    const wireBytes = await this.objectStore(storeId).get(BOX_STORE_MANIFEST_REL_PATH);
    const loadedManifest = new Map<string, BoxStoreManifestEntry>();
    if (wireBytes == null) {
      this.initializeManifestRevision(loadedManifest);
      this.manifest = loadedManifest;
      this.uncommittedStoreDbEntries.clear();
      this.fullyHydrated = undefined;
      this.hydrationManifestReadBlocked = false;
      return { present: false, manifest: loadedManifest };
    }
    const decoded = this.parseManifest(wireBytes);
    if (decoded == null) throw new BoxStoreSyncError("box store manifest is present but unparseable");
    for (const [relPath, entry] of Object.entries(decoded.entries)) loadedManifest.set(relPath, entry);
    this.initializeManifestRevision(loadedManifest, decoded.version === this.configuredManifestVersion() ? { revision: 0, fullyHydrated: decoded.fullyHydrated } : undefined);
    this.manifest = loadedManifest;
    this.uncommittedStoreDbEntries.clear();
    this.fullyHydrated = decoded.fullyHydrated;
    this.hydrationManifestReadBlocked = false;
    return { present: true, manifest: loadedManifest, fullyHydrated: decoded.fullyHydrated };
  }

  /** The legacy store says it is not complete: the marker goes, and the manifest records that much. */
  async markLegacyHydrationIncomplete(): Promise<void> {
    const storeId = await this.deps.resolveStoreId();
    if (this.deps.hydrationHandoffMarkerPath != null) await removeHydrationHandoffMarker(this.deps.hydrationHandoffMarkerPath);
    this.hydrationManifestReadBlocked = false;
    await this.loadManifest(storeId);
    await this.saveManifest(storeId, { hydrationUpdate: "mark-incomplete" });
  }

  /** The legacy store finished hydrating: the marker is what tells the next host that it may promote the manifest. */
  async markLegacyHydrationCompleteForHandoff(): Promise<void> {
    const markerPath = this.deps.hydrationHandoffMarkerPath;
    invariant(markerPath != null, "hydration handoff marker path is not configured");
    await writeHydrationHandoffMarker(markerPath);
  }
}
