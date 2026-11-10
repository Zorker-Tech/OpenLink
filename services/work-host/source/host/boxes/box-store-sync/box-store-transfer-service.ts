/**
 * Moving the box's files into its store, and knowing when not to.
 *
 * A cycle walks each category, and for every file it has to answer one question: *is the store already holding exactly
 * this?* The answers are layered because each one is cheaper than the next:
 *
 * - **the stat cache** — same mtime, same size, same mode as the last time this path was uploaded, and the manifest agrees
 *   on the hash: nothing to do;
 * - **the content hash** — read the file (or stream it, past the large-object threshold) and compare with what the
 *   manifest says; an identical hash is *unchanged*, not *uploaded*;
 * - **the store itself** — a blob is addressed by its hash, so putting it twice is free, which is why an upload can be
 *   attempted before the manifest is updated.
 *
 * Three things this file refuses to do: follow a symlink out of the category, carry a store database as a plain file (they
 * have their own capture), and carry its own temporary files. And a file that vanishes or becomes unreadable while the
 * cycle looks at it is a metadata failure for that file, not a failed cycle.
 */
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, open, readlink, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { forEachBounded } from "../box-transfer.ts";
import { sha256Hex } from "../../sha256.ts";
import { SQLITE_DB_SIDECAR_SUFFIXES } from "../../storage/store-db.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { BOX_STORE_BLOBS_PREFIX, isBoxStoreManifestFileEntry, type BoxStoreManifestEntry } from "./box-store-manifest-format.ts";
import { AGENT_STORE_DB_BASENAMES, type BoxManifestMap, type BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { BoxObjectStore, BoxObjectStoreProvider } from "./box-object-store.ts";
import {
  BOX_STORE_RESTORE_TMP_SUFFIX,
  BoxStoreDownload,
  copyFileHashing,
  LARGE_OBJECT_FREE_SPACE_FACTOR,
  sha256File,
  type BoxStoreDownloadOptions,
  type BoxStoreDownloadSummary,
} from "./box-store-download.ts";
import { BoxStorePackPipeline, type BoxStorePackCycleSummary } from "./box-store-pack-pipeline.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";
import type { WorkspaceIgnore } from "./workspace-ignore.ts";

import type { BoxStoreStagedFiles, CategoryTransferSummary, FileOutcome, BoxStoreTransferCategory, BoxStoreTransferDependencies, BoxStoreTransferOptions } from "./box-store-transfer-contracts.ts";
import {
  BOX_STORE_SNAPSHOT_TMP_SUFFIX,
  SNAPSHOT_OUT_LARGE_CONCURRENCY,
  classifyFileFailure,
  dedupeNestedRoots,
  globToRegExp,
  isSnapshotNodeRace,
  readFreeDiskBytes,
  tallyFileOutcome,
  tallyMetadataFailure,
  walkNodes,
} from "./box-store-transfer-primitives.ts";

interface ObservedFile {
  mtimeMs: number;
  size: number;
  mode: number;
}

interface TransferCandidate {
  relPath: string;
  absPath: string;
  fileStat: ObservedFile;
  nodeKind: "file" | "symlink";
  modeOverride?: number | undefined;
  bypassStatCache?: boolean;
}

interface FileReadResult {
  readonly content: Uint8Array;
  readonly observed: ObservedFile;
}

async function readRegularFile(absPath: string, modeOverride?: number): Promise<FileReadResult> {
  const handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const currentStat = await handle.stat();
    if (!currentStat.isFile()) throw new BoxStoreSyncError("snapshot source is not a regular file");
    const currentMode = (modeOverride ?? currentStat.mode) & 0o777;
    const content = await handle.readFile();
    return {
      content,
      observed: { mtimeMs: currentStat.mtimeMs, size: currentStat.size, mode: currentMode },
    };
  } finally {
    await handle.close();
  }
}

function localStatDescribesFile(
  cached: { readonly mtimeMs: number; readonly size: number; readonly sha: string } | undefined,
  previous: BoxStoreManifestEntry | undefined,
  observed: ObservedFile,
  skipCache: boolean,
): cached is { readonly mtimeMs: number; readonly size: number; readonly sha: string } {
  return !skipCache
    && cached !== undefined
    && cached.mtimeMs === observed.mtimeMs
    && cached.size === observed.size
    && previous !== undefined
    && isBoxStoreManifestFileEntry(previous)
    && previous.sha === cached.sha
    && previous.size === cached.size;
}

function exclusionsFor(category: BoxStoreTransferCategory): RegExp[] {
  const patterns = (category.excludes ?? []).map(globToRegExp);
  if (!category.containsAgentStoreDbs) return patterns;
  for (const databaseName of AGENT_STORE_DB_BASENAMES) {
    const variants = ["", ...SQLITE_DB_SIDECAR_SUFFIXES];
    for (const suffix of variants) patterns.push(globToRegExp(`${category.relPrefix}/**/${databaseName}${suffix}`));
    patterns.push(globToRegExp(`${category.relPrefix}/**/${databaseName}.corrupt-*`));
    patterns.push(globToRegExp(`${category.relPrefix}/**/${databaseName}.replacement*`));
    patterns.push(globToRegExp(`${category.relPrefix}/**/${databaseName}.pending`));
  }
  return patterns;
}

function excludedFromTransfer(relPath: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(relPath))
    || relPath.includes(BOX_STORE_SNAPSHOT_TMP_SUFFIX)
    || relPath.includes(BOX_STORE_RESTORE_TMP_SUFFIX);
}

function newCategorySummary(name: string): CategoryTransferSummary {
  return {
    name,
    filesScanned: 0,
    filesUploaded: 0,
    bytesUploaded: 0,
    skippedUnchanged: 0,
    removed: 0,
    oversize: 0,
    failures: 0,
    metadataFailures: 0,
  };
}

export class BoxStoreTransfer {
  private readonly deps: BoxStoreTransferDependencies;
  private readonly log: (message: string) => void;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly maxObjectBytes: number;
  private readonly readFreeDiskBytes: (path: string) => Promise<number | undefined>;
  private readonly uploadConcurrency: number;
  private readonly largeObjectThreshold: number;
  readonly packPipeline: BoxStorePackPipeline;
  readonly downloader: BoxStoreDownload;
  /** What each path looked like when it was last uploaded successfully: the cheapest "unchanged" answer. */
  readonly localStat = new Map<string, { mtimeMs: number; size: number; sha: string; mode: number }>();

  constructor(args: BoxStoreTransferOptions) {
    this.deps = args.deps;
    this.log = args.log;
    this.manifestStore = args.manifestStore;
    this.maxObjectBytes = args.maxObjectBytes;
    this.readFreeDiskBytes = args.deps.readFreeDiskBytes ?? readFreeDiskBytes;
    this.uploadConcurrency = args.uploadConcurrency;
    this.largeObjectThreshold = args.largeObjectThreshold;
    this.packPipeline = new BoxStorePackPipeline({
      categories: args.deps.categories,
      objectStore: (storeId) => this.objectStore(storeId),
      manifestStore: args.manifestStore,
      now: args.now,
      log: args.log,
      getFlushWaiters: args.getFlushWaiters,
      discardTemp: (temp) => this.discardTemp(temp),
      sha256File,
    });
    this.downloader = new BoxStoreDownload({
      resolveStoreId: args.deps.resolveStoreId,
      objectStore: (storeId) => this.objectStore(storeId),
      manifestStore: args.manifestStore,
      log: args.log,
      downloadConcurrency: args.downloadConcurrency,
      largeObjectThreshold: args.largeObjectThreshold,
      downloadByteBudget: args.downloadByteBudget,
      hasDiskSpaceForLargeObject: (path, bytes) => this.hasDiskSpaceForLargeObject(path, bytes),
      discardTemp: (temp) => this.discardTemp(temp),
      packPipeline: this.packPipeline,
    });
  }

  objectStore(storeId: string): BoxObjectStore {
    return this.deps.objectStoreProvider.forStore(storeId);
  }

  async discardTemp(args: { tmpPath: string; label: string }): Promise<void> {
    try {
      await unlink(args.tmpPath);
    } catch (error) {
      if (findSystemErrno(error) === "ENOENT") return;
      this.log(`temp cleanup failed ${args.label}: ${errorMessage(error)}`);
    }
  }

  async hasDiskSpaceForLargeObject(path: string, objectBytes: number): Promise<boolean> {
    const freeBytes = await this.readFreeDiskBytes(dirname(path));
    return freeBytes === undefined || freeBytes >= objectBytes * LARGE_OBJECT_FREE_SPACE_FACTOR;
  }

  /**
   * One file: the cache, then the hash, then the store. `modeOverride` is used for a staged file, whose mode comes from
   * the stage rather than from the file on disk.
   */
  async syncFile(
    storeId: string,
    manifest: BoxManifestMap,
    relPath: string,
    absPath: string,
    observedBeforeRead: ObservedFile,
    bypassStatCache = false,
    modeOverride?: number,
  ): Promise<FileOutcome> {
    const previousEntry = manifest.get(relPath);
    const requestedMode = (modeOverride ?? observedBeforeRead.mode) & 0o777;
    if (observedBeforeRead.size > this.maxObjectBytes) {
      this.log(`oversize ${relPath}: ${observedBeforeRead.size}B over ${this.maxObjectBytes}B`);
      return classifyFileFailure(previousEntry, requestedMode, "oversize");
    }

    const rememberedStat = this.localStat.get(relPath);
    if (localStatDescribesFile(rememberedStat, previousEntry, observedBeforeRead, bypassStatCache)) {
      this.localStat.set(relPath, { ...rememberedStat, mode: requestedMode });
      this.manifestStore.setManifestEntry(manifest, relPath, {
        kind: "file",
        sha: rememberedStat.sha,
        size: rememberedStat.size,
        mode: requestedMode,
      });
      return "unchanged";
    }

    if (observedBeforeRead.size >= this.largeObjectThreshold) {
      return this.writeStreamedBlob(storeId, manifest, relPath, absPath, observedBeforeRead.size, requestedMode, modeOverride);
    }
    return this.writeBufferedBlob(storeId, manifest, relPath, absPath, observedBeforeRead, requestedMode, modeOverride, previousEntry);
  }

  private async writeBufferedBlob(
    storeId: string,
    manifest: BoxManifestMap,
    relPath: string,
    absPath: string,
    observedBeforeRead: ObservedFile,
    mode: number,
    modeOverride: number | undefined,
    existing: BoxStoreManifestEntry | undefined,
  ): Promise<FileOutcome> {
    let snapshot: FileReadResult;
    try {
      snapshot = await readRegularFile(absPath, modeOverride);
    } catch (error) {
      this.log(`read failed ${relPath}: ${errorMessage(error)}`);
      return isSnapshotNodeRace(error) ? "metadata-error" : classifyFileFailure(existing, mode, "error");
    }

    const digest = sha256Hex(snapshot.content);
    const byteCount = snapshot.content.byteLength;
    mode = snapshot.observed.mode;
    this.localStat.set(relPath, { mtimeMs: snapshot.observed.mtimeMs, size: byteCount, sha: digest, mode });
    const alreadyPresent = existing !== undefined
      && isBoxStoreManifestFileEntry(existing)
      && existing.sha === digest
      && existing.size === byteCount;
    if (alreadyPresent) {
      this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha: digest, size: byteCount, mode });
      return "unchanged";
    }

    try {
      await this.objectStore(storeId).put(`${BOX_STORE_BLOBS_PREFIX}/${digest}`, snapshot.content, { contentAddressed: true });
    } catch (error) {
      this.log(`upload failed ${relPath}: ${errorMessage(error)}`);
      return classifyFileFailure(existing, mode, "error");
    }
    this.manifestStore.setManifestEntry(manifest, relPath, { kind: "file", sha: digest, size: byteCount, mode });
    return "uploaded";
  }

  /**
   * A file past the threshold is streamed to a temporary file, hashed on the way, and only then uploaded from disk — so a
   * large file never has to fit in memory, and a file being written while it is copied is detected by the hash.
   */
  private async writeStreamedBlob(
    storeId: string,
    manifest: BoxManifestMap,
    relPath: string,
    absPath: string,
    expectedSizeBytes: number,
    expectedMode: number,
    modeOverride?: number,
  ): Promise<FileOutcome> {
    const previousEntry = manifest.get(relPath);
    // A mode change alone is not worth a copy: if the content is what the store already has, adopt the new mode instead.
    if (previousEntry !== undefined && isBoxStoreManifestFileEntry(previousEntry) && previousEntry.mode !== expectedMode) {
      const retainedContent = await this.contentAlreadyKnown(absPath, previousEntry, expectedMode, modeOverride !== undefined).catch(() => undefined);
      if (retainedContent !== undefined) {
        this.localStat.set(relPath, retainedContent);
        this.manifestStore.setManifestEntry(manifest, relPath, {
          kind: "file",
          sha: retainedContent.sha,
          size: retainedContent.size,
          mode: retainedContent.mode,
        });
        return "unchanged";
      }
    }
    if (!(await this.hasDiskSpaceForLargeObject(absPath, expectedSizeBytes))) {
      this.log(`insufficient disk space for ${relPath} snapshot copy (${expectedSizeBytes}B needed x${LARGE_OBJECT_FREE_SPACE_FACTOR}); deferring to a later cycle`);
      return classifyFileFailure(previousEntry, expectedMode, "error");
    }

    const temporaryCopy = `${absPath}${BOX_STORE_SNAPSHOT_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
    let digest: string;
    let copiedBytes: number;
    let finalMode: number;
    try {
      const copySummary = await copyFileHashing(absPath, temporaryCopy);
      digest = copySummary.sha;
      copiedBytes = copySummary.size;
      finalMode = (modeOverride ?? copySummary.mode) & 0o777;
    } catch (error) {
      await this.discardTemp({ tmpPath: temporaryCopy, label: relPath });
      this.log(`read failed ${relPath}: ${errorMessage(error)}`);
      return isSnapshotNodeRace(error) ? "metadata-error" : classifyFileFailure(previousEntry, expectedMode, "error");
    }

    try {
      if (copiedBytes > this.maxObjectBytes) {
        this.log(`oversize ${relPath}: ${copiedBytes}B over ${this.maxObjectBytes}B`);
        return classifyFileFailure(previousEntry, finalMode, "oversize");
      }
      const alreadyStored = previousEntry !== undefined
        && isBoxStoreManifestFileEntry(previousEntry)
        && previousEntry.sha === digest
        && previousEntry.size === copiedBytes;
      if (!alreadyStored) {
        await this.objectStore(storeId).putFromFile!(
          `${BOX_STORE_BLOBS_PREFIX}/${digest}`,
          temporaryCopy,
          digest,
          copiedBytes,
        );
      }
      this.manifestStore.setManifestEntry(manifest, relPath, {
        kind: "file",
        sha: digest,
        size: copiedBytes,
        mode: finalMode,
      });
      await this.rememberStreamedSourceStat(relPath, absPath, digest, copiedBytes, finalMode);
      return alreadyStored ? "unchanged" : "uploaded";
    } catch (error) {
      this.log(`upload failed ${relPath}: ${errorMessage(error)}`);
      return classifyFileFailure(previousEntry, finalMode, "error");
    } finally {
      await this.discardTemp({ tmpPath: temporaryCopy, label: relPath });
    }
  }

  /**
   * Whether the file on disk is already the content the manifest names. The stat is taken twice — before and after the
   * hash — so a file that changed while it was hashed is not mistaken for a match.
   */
  private async contentAlreadyKnown(
    absPath: string,
    previousEntry: Exclude<BoxStoreManifestEntry, { kind: "symlink" }>,
    expectedMode: number,
    hasModeOverride: boolean,
  ) {
    const firstObservation = await lstat(absPath, { bigint: true });
    if (!firstObservation.isFile() || firstObservation.size !== BigInt(previousEntry.size)) return undefined;
    const digest = await sha256File(absPath);
    const secondObservation = await lstat(absPath, { bigint: true });
    const permissions = Number(secondObservation.mode) & 0o777;
    const sameFileStayedInPlace =
      secondObservation.isFile()
      && firstObservation.dev === secondObservation.dev
      && firstObservation.ino === secondObservation.ino
      && firstObservation.size === secondObservation.size
      && firstObservation.mtimeNs === secondObservation.mtimeNs
      && firstObservation.ctimeNs === secondObservation.ctimeNs
      && firstObservation.mode === secondObservation.mode;
    const sourceModeMatches = hasModeOverride || permissions === expectedMode;
    if (!sameFileStayedInPlace || digest !== previousEntry.sha || !sourceModeMatches) return undefined;
    return { mtimeMs: Number(secondObservation.mtimeNs) / 1e6, size: previousEntry.size, sha: digest, mode: expectedMode };
  }

  /** After a large upload: remember the stat only if the file is still the one that was uploaded. */
  private async rememberStreamedSourceStat(relPath: string, absPath: string, sha: string, size: number, mode: number): Promise<void> {
    try {
      const live = await lstat(absPath);
      if (live.isFile() && live.size === size && (live.mode & 0o777) === mode) {
        this.localStat.set(relPath, { mtimeMs: live.mtimeMs, size, sha, mode });
        return;
      }
    } catch {
      // A file that vanished is simply not cached; the next walk decides what to do about it.
    }
    this.localStat.delete(relPath);
  }

  private async writeSymlinkRecord(args: { manifest: BoxManifestMap; relPath: string; absPath: string }): Promise<"uploaded" | "unchanged" | "metadata-error"> {
    try {
      const target = await readlink(args.absPath);
      const changed = this.manifestStore.setManifestEntry(args.manifest, args.relPath, { kind: "symlink", target });
      this.localStat.delete(args.relPath);
      return changed ? "uploaded" : "unchanged";
    } catch (error) {
      this.log(`readlink failed ${args.relPath}: ${errorMessage(error)}`);
      return "metadata-error";
    }
  }

  private async stageCategoryFiles(
    category: BoxStoreTransferCategory,
    sourceExists: boolean,
  ): Promise<BoxStoreStagedFiles | undefined> {
    if (category.stage === undefined || !sourceExists) return undefined;
    try {
      return await category.stage();
    } catch (error) {
      this.log(`stage ${category.name} failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async scanCategoryTree(
    category: BoxStoreTransferCategory,
    exclusionPatterns: readonly RegExp[],
    ignore: WorkspaceIgnore | undefined,
    summary: CategoryTransferSummary,
    seenPaths: Set<string>,
  ): Promise<{ readonly candidates: TransferCandidate[]; readonly complete: boolean }> {
    const candidates: TransferCandidate[] = [];
    let traversalComplete = true;
    const skipDirectory = ignore == null
      ? undefined
      : (relativeDirectory: string) => {
          if (!ignore.canPruneDir(relativeDirectory)) return false;
          summary.prunedDirs = (summary.prunedDirs ?? 0) + 1;
          return true;
        };

    for await (const node of walkNodes(category.absRoot, skipDirectory)) {
      if (node.kind === "readdir-error") {
        traversalComplete = false;
        tallyMetadataFailure(summary);
        continue;
      }

      const absolutePath = node.absPath;
      const handoffMarker = this.deps.hydrationHandoffMarkerPath;
      if (handoffMarker !== undefined && (absolutePath === handoffMarker || (absolutePath.startsWith(`${handoffMarker}.`) && absolutePath.endsWith(".tmp")))) continue;

      const pathFromRoot = relative(category.absRoot, absolutePath).split(sep).join("/");
      const manifestPath = `${category.relPrefix}/${pathFromRoot}`;
      if (excludedFromTransfer(manifestPath, exclusionPatterns)) continue;

      let fileDetails;
      try {
        fileDetails = await lstat(absolutePath);
      } catch {
        seenPaths.add(manifestPath);
        tallyMetadataFailure(summary);
        continue;
      }
      if (!fileDetails.isFile() && !fileDetails.isSymbolicLink()) {
        seenPaths.add(manifestPath);
        tallyMetadataFailure(summary);
        continue;
      }
      if (ignore?.ignores(pathFromRoot) === true) {
        summary.excludedFiles = (summary.excludedFiles ?? 0) + 1;
        summary.excludedBytes = (summary.excludedBytes ?? 0) + fileDetails.size;
        continue;
      }

      seenPaths.add(manifestPath);
      candidates.push({
        relPath: manifestPath,
        absPath: absolutePath,
        fileStat: fileDetails,
        nodeKind: fileDetails.isSymbolicLink() ? "symlink" : "file",
      });
    }
    return { candidates, complete: traversalComplete };
  }

  private async stagedCandidates(
    staged: BoxStoreStagedFiles | undefined,
    seenPaths: Set<string>,
    summary: CategoryTransferSummary,
  ): Promise<TransferCandidate[]> {
    const candidates: TransferCandidate[] = [];
    for (const stagedFile of staged?.files ?? []) {
      let fileDetails;
      try {
        fileDetails = await lstat(stagedFile.absPath);
      } catch {
        tallyMetadataFailure(summary);
        continue;
      }
      if (!fileDetails.isFile()) {
        tallyMetadataFailure(summary);
        continue;
      }
      seenPaths.add(stagedFile.relPath);
      candidates.push({
        relPath: stagedFile.relPath,
        absPath: stagedFile.absPath,
        fileStat: fileDetails,
        nodeKind: "file",
        modeOverride: stagedFile.mode,
        bypassStatCache: true,
      });
    }
    return candidates;
  }

  private pruneMissingCategoryEntries(
    category: BoxStoreTransferCategory,
    manifest: BoxManifestMap,
    seenPaths: ReadonlySet<string>,
    exclusionPatterns: readonly RegExp[],
    summary: CategoryTransferSummary,
  ): void {
    for (const relPath of [...manifest.keys()]) {
      if (!relPath.startsWith(`${category.relPrefix}/`) || exclusionPatterns.some((pattern) => pattern.test(relPath)) || seenPaths.has(relPath)) continue;
      this.manifestStore.deleteManifestEntry(manifest, relPath);
      this.localStat.delete(relPath);
      summary.removed += 1;
    }
  }

  /**
   * One category: stage it if it has a stage, walk it, upload what changed, and remove from the manifest whatever is no
   * longer there (only when the walk itself was complete — a directory that could not be read is not an empty one).
   */
  async syncCategory(storeId: string, category: BoxStoreTransferCategory): Promise<CategoryTransferSummary> {
    const summary = newCategorySummary(category.name);
    const sourceExists = category.stageOnly === true || existsSync(category.absRoot);
    const staged = await this.stageCategoryFiles(category, sourceExists);
    try {
      const exclusionPatterns = exclusionsFor(category);
      const seenPaths = new Set<string>();
      const manifest = await this.manifestStore.loadManifest(storeId);
      const ignore = category.ignore?.();
      const scan = category.stageOnly === true || !sourceExists
        ? { candidates: [] as TransferCandidate[], complete: true }
        : await this.scanCategoryTree(category, exclusionPatterns, ignore, summary, seenPaths);
      if (ignore != null && ((summary.prunedDirs ?? 0) > 0 || (summary.excludedFiles ?? 0) > 0)) {
        this.log(`${category.name} ignore: pruned ${summary.prunedDirs ?? 0} dirs, excluded ${summary.excludedFiles ?? 0} files (${summary.excludedBytes ?? 0}B)`);
      }
      const stagedFiles = await this.stagedCandidates(staged, seenPaths, summary);
      await this.uploadCategoryCandidates(storeId, manifest, [...scan.candidates, ...stagedFiles], summary);
      summary.failures += staged?.skipped ?? 0;

      if (category.stageOnly !== true && scan.complete) {
        this.pruneMissingCategoryEntries(category, manifest, seenPaths, exclusionPatterns, summary);
      }
      return summary;
    } finally {
      await staged?.cleanup().catch((error) => {
        this.log(`stage cleanup ${category.name} failed: ${errorMessage(error)}`);
      });
    }
  }

  /** Small files go up at the upload concurrency, large ones at the large-object concurrency: two knobs, one queue each. */
  private async uploadCategoryCandidates(storeId: string, manifest: BoxManifestMap, candidates: readonly TransferCandidate[], summary: CategoryTransferSummary): Promise<void> {
    const small: TransferCandidate[] = [];
    const large: TransferCandidate[] = [];
    for (const candidate of candidates) (candidate.nodeKind === "file" && candidate.fileStat.size >= this.largeObjectThreshold ? large : small).push(candidate);
    const upload = async (candidate: TransferCandidate) => {
      let fileStat;
      try {
        fileStat = await lstat(candidate.absPath);
      } catch {
        tallyMetadataFailure(summary);
        return;
      }
      summary.filesScanned += 1;
      if (fileStat.isSymbolicLink()) {
        tallyFileOutcome(summary, await this.writeSymlinkRecord({ manifest, relPath: candidate.relPath, absPath: candidate.absPath }), 0);
        return;
      }
      if (!fileStat.isFile()) {
        tallyMetadataFailure(summary);
        return;
      }
      const outcome = await this.syncFile(
        storeId,
        manifest,
        candidate.relPath,
        candidate.absPath,
        { mtimeMs: fileStat.mtimeMs, size: fileStat.size, mode: fileStat.mode },
        candidate.bypassStatCache === true,
        candidate.modeOverride,
      );
      tallyFileOutcome(summary, outcome, fileStat.size);
    };
    await forEachBounded(small, this.uploadConcurrency, upload);
    await forEachBounded(large, SNAPSHOT_OUT_LARGE_CONCURRENCY, upload);
  }

  async syncPacks(storeId: string): Promise<BoxStorePackCycleSummary> {
    return this.packPipeline.syncPacks(storeId);
  }

  async download(targetDir: string, options: BoxStoreDownloadOptions = {}): Promise<BoxStoreDownloadSummary> {
    return this.downloader.download(targetDir, options);
  }

  /** A previous host that died mid-copy leaves its snapshot and restore temporaries behind: they are swept once, at start. */
  async sweepLeakedTemps(): Promise<number> {
    const roots = dedupeNestedRoots(this.deps.categories.filter((category) => !category.stageOnly).map((category) => category.absRoot));
    let removed = 0;
    for (const root of roots) {
      for await (const node of walkNodes(root)) {
        if (node.kind !== "file" || (!node.absPath.includes(BOX_STORE_SNAPSHOT_TMP_SUFFIX) && !node.absPath.includes(BOX_STORE_RESTORE_TMP_SUFFIX))) continue;
        try {
          await unlink(node.absPath);
          removed += 1;
        } catch {
          // A temporary that cannot be removed is left for the next start.
        }
      }
    }
    return removed;
  }
}
