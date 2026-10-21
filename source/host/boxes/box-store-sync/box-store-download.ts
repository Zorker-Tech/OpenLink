/**
 * Restoring a box's store onto a box.
 *
 * A restore is the dangerous direction — it writes into a filesystem — so the rules are about what may be written and where:
 *
 * - **a path is only written if it is inside the target root** — an absolute path, an empty segment, a `.` or a `..` is a
 *   refusal, and a symlink is only created when its target stays inside the root too;
 * - **a file is only installed after it is verified** — every blob is hashed as it is written (or after it is streamed) and
 *   compared with the manifest, and the destination is replaced by a rename, so a half-written file is never visible;
 * - **the critical files go first** — the store databases and the chrome session are what a box needs to be usable, so they
 *   are restored before the bulk; the bulk is what a pack can carry, when packs exist;
 * - **big blobs are streamed, small ones are shared** — blobs are grouped by hash, so a file that appears ten times is
 *   fetched once; a large group is restored once and copied for the rest.
 *
 * Two more things are worth knowing before changing this file: the phases are pipelined by wave (a wave of 500 groups is
 * prepared while the previous one is restored, which is where prefetch happens), and every symlink step is traced so a
 * restore that stalls can say which step it stalled in.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lchown, lstat, mkdir, open, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { forEachBounded, forEachWavePipelined } from "../box-transfer.ts";
import { sha256Hex } from "../../sha256.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { findSystemErrno } from "../../../shared/system-errno.ts";
import { BOX_STORE_BLOBS_PREFIX, isBoxStoreManifestFileEntry, isBoxStoreManifestSymlinkEntry, type BoxStoreManifestEntry } from "./box-store-manifest-format.ts";
import type { BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { BoxObjectStore } from "./box-object-store.ts";
import type { BoxStoreBlobGroup, BoxStoreByteBudget, BoxStorePackPipeline } from "./box-store-pack-pipeline.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";

export const COPY_IN_LARGE_BLOB_CONCURRENCY = 4;
export const COPY_IN_WAVE_SIZE = 500;
export const BOX_STORE_RESTORE_TMP_SUFFIX = ".box-store-part-";
export const LARGE_OBJECT_FREE_SPACE_FACTOR = 2;
/** The files a box needs to be usable: they are restored before anything else. */
export const COPY_IN_CRITICAL_BASENAMES = new Set(["store.db", "conversation-blobs.db", "Cookies", "Login Data", "Web Data", "source-map.json"]);

export function isCriticalRelPath(relPath: string): boolean {
  return COPY_IN_CRITICAL_BASENAMES.has(relPath.slice(relPath.lastIndexOf("/") + 1));
}

type ManifestFileEntry = Exclude<BoxStoreManifestEntry, { kind: "symlink" }>;
type ManifestSymlinkEntry = Extract<BoxStoreManifestEntry, { kind: "symlink" }>;

export type BoxStoreSymlinkStep =
  | "prepare-parent"
  | "match-existing"
  | "create-temp"
  | "inspect-destination"
  | "remove-directory"
  | "rename-temp"
  | "apply-owner"
  | "verify-target"
  | "cleanup-temp";

export interface BoxStoreDownloadTrace {
  readonly event: string;
  readonly manifestEntries: number;
  readonly fileEntries: number;
  readonly symlinkEntries: number;
  readonly symlinksStarted: number;
  readonly symlinksCompleted: number;
  readonly symlinksInFlight: number;
  readonly activeSymlinkSteps: Record<BoxStoreSymlinkStep, number>;
  readonly symlinkOrdinal?: number;
  readonly symlinkStep?: BoxStoreSymlinkStep;
  readonly symlinkOutcome?: "restored" | "failed";
}

export interface BoxStoreDownloadOptions {
  readonly manifest?: ReadonlyMap<string, BoxStoreManifestEntry>;
  readonly uid?: number;
  readonly gid?: number;
  chown?(path: string, uid: number, gid: number): Promise<void>;
  lchown?(path: string, uid: number, gid: number): Promise<void>;
  onProgress?(progress: { files: number; bytes: number; verified: number; total: number }): void;
  onTrace?(trace: BoxStoreDownloadTrace): void;
}

export interface BoxStoreDownloadSummary {
  readonly manifestEntries: number;
  readonly files: number;
  readonly bytes: number;
  readonly verified: number;
  readonly failures: string[];
}

export interface BoxStoreDownloadOptionsPort {
  resolveStoreId(): Promise<string>;
  objectStore(storeId: string): BoxObjectStore;
  readonly manifestStore: BoxStoreManifestStore;
  log(message: string): void;
  readonly downloadConcurrency: number;
  readonly largeObjectThreshold: number;
  readonly downloadByteBudget: number;
  hasDiskSpaceForLargeObject(path: string, objectBytes: number): Promise<boolean>;
  discardTemp(args: { tmpPath: string; label: string }): Promise<void>;
  readonly packPipeline: Pick<BoxStorePackPipeline, "restoreBulkSmallFromPacks">;
}

export class BoxStoreDownload {
  private readonly resolveStoreId: () => Promise<string>;
  private readonly objectStore: (storeId: string) => BoxObjectStore;
  private readonly manifestStore: BoxStoreManifestStore;
  private readonly log: (message: string) => void;
  private readonly downloadConcurrency: number;
  private readonly largeObjectThreshold: number;
  private readonly downloadByteBudget: number;
  private readonly hasDiskSpaceForLargeObject: (path: string, objectBytes: number) => Promise<boolean>;
  private readonly discardTemp: (args: { tmpPath: string; label: string }) => Promise<void>;
  private readonly packPipeline: Pick<BoxStorePackPipeline, "restoreBulkSmallFromPacks">;

  constructor(args: BoxStoreDownloadOptionsPort) {
    this.resolveStoreId = args.resolveStoreId;
    this.objectStore = args.objectStore;
    this.manifestStore = args.manifestStore;
    this.log = args.log;
    this.downloadConcurrency = args.downloadConcurrency;
    this.largeObjectThreshold = args.largeObjectThreshold;
    this.downloadByteBudget = args.downloadByteBudget;
    this.hasDiskSpaceForLargeObject = args.hasDiskSpaceForLargeObject;
    this.discardTemp = args.discardTemp;
    this.packPipeline = args.packPipeline;
  }

  async download(targetDir: string, options: BoxStoreDownloadOptions = {}): Promise<BoxStoreDownloadSummary> {
    const storeId = await this.resolveStoreId();
    const store = this.objectStore(storeId);
    let manifest: ReadonlyMap<string, BoxStoreManifestEntry>;
    if (options.manifest != null) {
      manifest = options.manifest;
    } else {
      // A restore is not a snapshot: the cached manifest is dropped so what is restored is what the store holds now.
      this.manifestStore.manifest = undefined;
      manifest = await this.manifestStore.loadManifest(storeId);
    }

    const failures: string[] = [];
    let files = 0;
    let bytes = 0;
    let verified = 0;
    const targetRoot = resolve(targetDir);
    const fileEntries = new Map<string, ManifestFileEntry>();
    const symlinkEntries = new Map<string, ManifestSymlinkEntry>();
    const destinationPaths = new Map<string, string>();
    const claimedDestinations = new Set<string>();

    for (const [relPath, entry] of manifest) {
      const destPath = resolveRestoreDestination({ targetRoot, relPath });
      // Two entries that resolve to the same place would make the restore depend on iteration order.
      if (destPath == null || claimedDestinations.has(destPath)) {
        failures.push(`${relPath}: unsafe manifest path`);
        continue;
      }
      claimedDestinations.add(destPath);
      destinationPaths.set(relPath, destPath);
      if (isBoxStoreManifestFileEntry(entry)) fileEntries.set(relPath, entry);
      else if (isBoxStoreManifestSymlinkEntry(entry)) symlinkEntries.set(relPath, entry);
    }

    let symlinksStarted = 0;
    let symlinksCompleted = 0;
    const activeSymlinkSteps: Record<BoxStoreSymlinkStep, number> = {
      "prepare-parent": 0,
      "match-existing": 0,
      "create-temp": 0,
      "inspect-destination": 0,
      "remove-directory": 0,
      "rename-temp": 0,
      "apply-owner": 0,
      "verify-target": 0,
      "cleanup-temp": 0,
    };
    const reportTrace = (event: string, detail: Partial<Pick<BoxStoreDownloadTrace, "symlinkOrdinal" | "symlinkStep" | "symlinkOutcome">> = {}): void => {
      options.onTrace?.({
        event,
        manifestEntries: manifest.size,
        fileEntries: fileEntries.size,
        symlinkEntries: symlinkEntries.size,
        symlinksStarted,
        symlinksCompleted,
        symlinksInFlight: symlinksStarted - symlinksCompleted,
        activeSymlinkSteps: { ...activeSymlinkSteps },
        ...detail,
      });
    };
    const runSymlinkStep = async <T>(step: BoxStoreSymlinkStep, symlinkOrdinal: number, operation: () => Promise<T>): Promise<T> => {
      activeSymlinkSteps[step] += 1;
      reportTrace("symlink-step-started", { symlinkOrdinal, symlinkStep: step });
      try {
        return await operation();
      } finally {
        activeSymlinkSteps[step] -= 1;
        reportTrace("symlink-step-finished", { symlinkOrdinal, symlinkStep: step });
      }
    };
    reportTrace("manifest-planned");

    /**
     * Creates a directory under the target root, segment by segment, refusing anything that would leave it. A directory
     * that is in the way (a file with its name) is removed when it is a file, and the root itself must be a directory.
     */
    const mkdirOwned = async (dir: string): Promise<void> => {
      const relDir = relative(targetRoot, dir);
      if (relDir === ".." || relDir.startsWith(`..${sep}`) || isAbsolute(relDir)) throw new BoxStoreSyncError("restore directory escapes the target root");
      const rootStat = await lstat(targetRoot);
      if (!rootStat.isDirectory()) throw new BoxStoreSyncError("restore target root is not a directory");

      let current = targetRoot;
      for (const segment of relDir === "" ? [] : relDir.split(sep)) {
        current = join(current, segment);
        let created = false;
        let info;
        try {
          info = await lstat(current);
        } catch (error) {
          if (findSystemErrno(error) !== "ENOENT") throw error;
          try {
            await mkdir(current);
            created = true;
          } catch (mkdirError) {
            if (findSystemErrno(mkdirError) !== "EEXIST") throw mkdirError;
          }
          info = await lstat(current);
        }
        if (!info.isDirectory()) {
          // Something that is not a directory sits where a directory is needed: replace it, unless a concurrent restore
          // already made it the directory it was going to be.
          try {
            await unlink(current);
          } catch (error) {
            if (findSystemErrno(error) !== "ENOENT") {
              const raced = await lstat(current).then(
                (value) => value,
                () => undefined,
              );
              if (!raced?.isDirectory()) throw error;
              info = raced;
            }
          }
          if (!info.isDirectory()) {
            try {
              await mkdir(current);
              created = true;
            } catch (mkdirError) {
              if (findSystemErrno(mkdirError) !== "EEXIST") throw mkdirError;
            }
            info = await lstat(current);
          }
          if (!info.isDirectory()) throw new BoxStoreSyncError("restore parent is not a directory");
        }
        if (created && options.uid != null && options.gid != null) {
          if (options.chown != null) await options.chown(current, options.uid, options.gid);
          else await lchown(current, options.uid, options.gid);
        }
      }
    };

    /** Applies the entry's owner and mode through an open handle, so what is changed is the file that was verified. */
    const applyOpenFileMetadata = async (path: string, entry: ManifestFileEntry, deferInjectedChown: boolean, legacyReplacementMode?: number): Promise<void> => {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new BoxStoreSyncError("restore destination is not a regular file");
        if (options.uid != null && options.gid != null && options.chown == null) await handle.chown(options.uid, options.gid);
        const mode = entry.kind === "file" ? entry.mode : legacyReplacementMode;
        if (mode != null) await handle.chmod(mode);
      } finally {
        await handle.close();
      }
      if (!deferInjectedChown && options.chown != null && options.uid != null && options.gid != null) await options.chown(path, options.uid, options.gid);
    };

    const existingRegularFileMode = async (path: string): Promise<number | undefined> => {
      const destination = await lstat(path).then(
        (value) => value,
        (error) => {
          if (findSystemErrno(error) === "ENOENT") return undefined;
          throw error;
        },
      );
      return destination?.isFile() ? destination.mode & 0o777 : undefined;
    };

    /** Moves a verified temporary into place, removing a directory that is in the way first. */
    const replaceDestinationWithTemp = async (tmpPath: string, destPath: string, symlinkOrdinal?: number): Promise<void> => {
      const inspectDestination = async () =>
        await lstat(destPath).then(
          (value) => value,
          (error) => {
            if (findSystemErrno(error) === "ENOENT") return undefined;
            throw error;
          },
        );
      const destination = symlinkOrdinal == null ? await inspectDestination() : await runSymlinkStep("inspect-destination", symlinkOrdinal, inspectDestination);
      if (destination?.isDirectory()) {
        if (symlinkOrdinal == null) await rm(destPath, { recursive: true, force: true });
        else
          await runSymlinkStep("remove-directory", symlinkOrdinal, async () => {
            await rm(destPath, { recursive: true, force: true });
          });
      }
      if (symlinkOrdinal == null) await rename(tmpPath, destPath);
      else
        await runSymlinkStep("rename-temp", symlinkOrdinal, async () => {
          await rename(tmpPath, destPath);
        });
    };

    const installVerifiedTemp = async (tmpPath: string, destPath: string, relPath: string): Promise<void> => {
      const entry = fileEntries.get(relPath);
      if (entry == null) throw new BoxStoreSyncError("the regular-file manifest entry is missing");
      // A legacy entry has no mode: the destination's own mode is kept, if there is one to keep.
      const legacyReplacementMode = entry.kind === undefined ? await existingRegularFileMode(destPath) : undefined;
      await applyOpenFileMetadata(tmpPath, entry, true, legacyReplacementMode);
      await replaceDestinationWithTemp(tmpPath, destPath);
      if (options.chown != null && options.uid != null && options.gid != null) await options.chown(destPath, options.uid, options.gid);
    };

    const applyExistingFileMetadata = async (destPath: string, relPath: string): Promise<void> => {
      const entry = fileEntries.get(relPath);
      if (entry == null) throw new BoxStoreSyncError("the regular-file manifest entry is missing");
      await applyOpenFileMetadata(destPath, entry, false);
    };

    const writeVerifiedBytes = async (destPath: string, relPath: string, blob: Uint8Array): Promise<void> => {
      const tmpPath = `${destPath}${BOX_STORE_RESTORE_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
      try {
        await writeFile(tmpPath, blob, { flag: "wx" });
        await installVerifiedTemp(tmpPath, destPath, relPath);
      } finally {
        await this.discardTemp({ tmpPath, label: relPath });
      }
    };

    const applySymlinkOwner = async (path: string): Promise<void> => {
      if (options.uid == null || options.gid == null) return;
      await (options.lchown ?? lchown)(path, options.uid, options.gid);
    };
    const localSymlinkMatches = async (destPath: string, entry: ManifestSymlinkEntry): Promise<boolean> => {
      const info = await lstat(destPath).then(
        (value) => value,
        () => null,
      );
      if (!info?.isSymbolicLink()) return false;
      const target = await readlink(destPath).then(
        (value) => value,
        () => null,
      );
      return target === entry.target;
    };

    /** A symlink, by steps: parent, reuse-or-recreate, owner, verify. Every step is traced so a stall is locatable. */
    const restoreSymlink = async (relPath: string, entry: ManifestSymlinkEntry, symlinkOrdinal: number): Promise<boolean> => {
      const destPath = destinationPaths.get(relPath);
      if (destPath == null || !symlinkTargetStaysWithinRoot({ targetRoot, destPath, target: entry.target })) {
        failures.push(`${relPath}: unsafe symlink target`);
        return false;
      }
      try {
        await runSymlinkStep("prepare-parent", symlinkOrdinal, async () => {
          await mkdirOwned(dirname(destPath));
        });
        const alreadyCorrect = await runSymlinkStep("match-existing", symlinkOrdinal, async () => await localSymlinkMatches(destPath, entry));
        if (alreadyCorrect) {
          await runSymlinkStep("apply-owner", symlinkOrdinal, async () => {
            await applySymlinkOwner(destPath);
          });
        } else {
          const tmpPath = `${destPath}${BOX_STORE_RESTORE_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
          try {
            await runSymlinkStep("create-temp", symlinkOrdinal, async () => {
              await symlink(entry.target, tmpPath);
            });
            await replaceDestinationWithTemp(tmpPath, destPath, symlinkOrdinal);
            await runSymlinkStep("apply-owner", symlinkOrdinal, async () => {
              await applySymlinkOwner(destPath);
            });
          } finally {
            await runSymlinkStep("cleanup-temp", symlinkOrdinal, async () => {
              await this.discardTemp({ tmpPath, label: relPath });
            });
          }
          const verifiedTarget = await runSymlinkStep("verify-target", symlinkOrdinal, async () => await localSymlinkMatches(destPath, entry));
          if (!verifiedTarget) throw new BoxStoreSyncError("the restored symlink target does not match");
        }
      } catch (error) {
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return false;
      }
      verified += 1;
      files += 1;
      reportProgress();
      return true;
    };

    const reportProgress = (): void => {
      options.onProgress?.({ files, bytes, verified, total: manifest.size });
    };
    const byteBudget = makeInFlightByteBudget(this.downloadByteBudget);

    const restoreSmallGroup = async (group: BoxStoreBlobGroup, pending: readonly string[]): Promise<void> => {
      await byteBudget.acquire(group.size);
      try {
        let blob: Uint8Array | null;
        try {
          blob = await store.get(`${BOX_STORE_BLOBS_PREFIX}/${group.sha}`);
        } catch (error) {
          for (const relPath of pending) failures.push(`${relPath}: ${errorMessage(error)}`);
          return;
        }
        if (blob == null) {
          for (const relPath of pending) failures.push(`${relPath}: blob ${group.sha} missing`);
          return;
        }
        if (blob.byteLength !== group.size || sha256Hex(blob) !== group.sha) {
          for (const relPath of pending) failures.push(`${relPath}: sha/size mismatch`);
          return;
        }
        for (const relPath of pending) {
          verified += 1;
          const destPath = destinationPaths.get(relPath);
          if (destPath == null) {
            failures.push(`${relPath}: unsafe manifest path`);
            continue;
          }
          try {
            await mkdirOwned(dirname(destPath));
            await writeVerifiedBytes(destPath, relPath, blob);
          } catch (error) {
            failures.push(`${relPath}: ${errorMessage(error)}`);
            continue;
          }
          files += 1;
          bytes += blob.byteLength;
          reportProgress();
        }
      } finally {
        byteBudget.release(group.size);
      }
    };

    const restoreLargeToPath = async (group: BoxStoreBlobGroup, relPath: string): Promise<boolean> => {
      const destPath = destinationPaths.get(relPath);
      if (destPath == null) {
        failures.push(`${relPath}: unsafe manifest path`);
        return false;
      }
      try {
        await mkdirOwned(dirname(destPath));
      } catch (error) {
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return false;
      }
      if (!(await this.hasDiskSpaceForLargeObject(destPath, group.size))) {
        failures.push(`${relPath}: insufficient disk space for a ${group.size}B restore (x${LARGE_OBJECT_FREE_SPACE_FACTOR} required)`);
        return false;
      }
      const tmpPath = `${destPath}${BOX_STORE_RESTORE_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
      let written: number | null;
      try {
        written = await store.getToFile!(`${BOX_STORE_BLOBS_PREFIX}/${group.sha}`, tmpPath, { maxBytes: group.size });
      } catch (error) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return false;
      }
      if (written == null) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: blob ${group.sha} missing`);
        return false;
      }
      let actualSha: string;
      try {
        actualSha = await sha256File(tmpPath);
      } catch (error) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return false;
      }
      if (written !== group.size || actualSha !== group.sha) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: sha/size mismatch`);
        return false;
      }
      verified += 1;
      try {
        await installVerifiedTemp(tmpPath, destPath, relPath);
      } catch (error) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return false;
      }
      files += 1;
      bytes += written;
      reportProgress();
      return true;
    };

    /** A second (third, …) path with the same content is a local copy of the one that was just restored. */
    const copyLargeToPath = async (sourcePath: string, group: BoxStoreBlobGroup, relPath: string): Promise<void> => {
      const destPath = destinationPaths.get(relPath);
      if (destPath == null) {
        failures.push(`${relPath}: unsafe manifest path`);
        return;
      }
      try {
        await mkdirOwned(dirname(destPath));
      } catch (error) {
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return;
      }
      if (!(await this.hasDiskSpaceForLargeObject(destPath, group.size))) {
        failures.push(`${relPath}: insufficient disk space for a ${group.size}B restore (x${LARGE_OBJECT_FREE_SPACE_FACTOR} required)`);
        return;
      }
      const tmpPath = `${destPath}${BOX_STORE_RESTORE_TMP_SUFFIX}${randomBytes(8).toString("hex")}`;
      try {
        const copied = await copyFileHashing(sourcePath, tmpPath);
        if (copied.size !== group.size || copied.sha !== group.sha) {
          await this.discardTemp({ tmpPath, label: relPath });
          failures.push(`${relPath}: sha/size mismatch`);
          return;
        }
        verified += 1;
        await installVerifiedTemp(tmpPath, destPath, relPath);
      } catch (error) {
        await this.discardTemp({ tmpPath, label: relPath });
        failures.push(`${relPath}: ${errorMessage(error)}`);
        return;
      }
      files += 1;
      bytes += group.size;
      reportProgress();
    };

    const restoreLargeGroup = async (group: BoxStoreBlobGroup, pending: readonly string[]): Promise<void> => {
      let restoredPath: string | undefined;
      for (const relPath of pending) {
        if (restoredPath == null) {
          if (await restoreLargeToPath(group, relPath)) restoredPath = destinationPaths.get(relPath);
        } else {
          await copyLargeToPath(restoredPath, group, relPath);
        }
      }
    };

    const localFileMatches = async (destPath: string, group: BoxStoreBlobGroup): Promise<boolean> => {
      try {
        const local = await lstat(destPath);
        if (!local.isFile() || local.size !== group.size) return false;
        return (await sha256File(destPath)) === group.sha;
      } catch {
        return false;
      }
    };

    /**
     * One phase, in waves: each wave is prepared (what is already correct is verified in place, the rest is fetched) while
     * the previous wave is restored, and a wave that has remote work gets its read urls prefetched in one request.
     */
    const runPhase = async (groups: readonly BoxStoreBlobGroup[], concurrency: number, restoreGroup: (group: BoxStoreBlobGroup, pending: readonly string[]) => Promise<void>): Promise<void> => {
      await forEachWavePipelined(groups, {
        waveSize: COPY_IN_WAVE_SIZE,
        concurrency,
        prepareWave: async (wave) => {
          const remote: Array<{ group: BoxStoreBlobGroup; pending: string[] }> = [];
          await forEachBounded(wave, concurrency, async (group) => {
            const pending: string[] = [];
            for (const relPath of group.relPaths) {
              const destPath = destinationPaths.get(relPath);
              if (destPath == null) continue;
              try {
                await mkdirOwned(dirname(destPath));
              } catch (error) {
                failures.push(`${relPath}: ${errorMessage(error)}`);
                continue;
              }
              if (await localFileMatches(destPath, group)) {
                verified += 1;
                try {
                  await applyExistingFileMetadata(destPath, relPath);
                } catch (error) {
                  failures.push(`${relPath}: ${errorMessage(error)}`);
                  continue;
                }
                files += 1;
                bytes += group.size;
                reportProgress();
              } else {
                pending.push(relPath);
              }
            }
            if (pending.length > 0) remote.push({ group, pending });
          });
          if (remote.length > 0 && store.prefetchReads != null) {
            try {
              await store.prefetchReads(remote.map(({ group }) => `${BOX_STORE_BLOBS_PREFIX}/${group.sha}`));
            } catch (error) {
              // Prefetching is an optimisation: without it each blob is presigned on its own.
              this.log(`read prefetch failed (falling back to per-blob presign): ${errorMessage(error)}`);
            }
          }
          return remote;
        },
        process: ({ group, pending }) => restoreGroup(group, pending),
      });
    };

    // The order of the phases is the order a box becomes usable in: its databases and browser session, then the large
    // critical files, then whatever a pack can carry, then the rest of the large ones, then the symlinks.
    const criticalSmall = new Map<string, BoxStoreBlobGroup>();
    const criticalLarge = new Map<string, BoxStoreBlobGroup>();
    const bulkSmall = new Map<string, BoxStoreBlobGroup>();
    const bulkLarge = new Map<string, BoxStoreBlobGroup>();
    for (const [relPath, entry] of fileEntries) {
      const isLarge = entry.size >= this.largeObjectThreshold;
      const phase = isCriticalRelPath(relPath) ? (isLarge ? criticalLarge : criticalSmall) : isLarge ? bulkLarge : bulkSmall;
      const key = `${entry.sha}:${entry.size}`;
      const group = phase.get(key);
      if (group == null) phase.set(key, { sha: entry.sha, size: entry.size, relPaths: [relPath] });
      else group.relPaths.push(relPath);
    }

    await runPhase([...criticalSmall.values()], this.downloadConcurrency, restoreSmallGroup);
    await runPhase([...criticalLarge.values()], COPY_IN_LARGE_BLOB_CONCURRENCY, restoreLargeGroup);
    const restoredByPack = await this.packPipeline.restoreBulkSmallFromPacks({
      store,
      targetDir,
      groups: bulkSmall,
      byteBudget,
      localFileMatches,
      mkdirOwned,
      applyExistingFileMetadata,
      writeVerifiedBytes,
      recordRestoredPath: (byteSize) => {
        verified += 1;
        files += 1;
        bytes += byteSize;
        reportProgress();
      },
    });

    const remainingBulkSmall: BoxStoreBlobGroup[] = [];
    for (const group of bulkSmall.values()) {
      const pending = group.relPaths.filter((relPath) => !restoredByPack.has(relPath));
      if (pending.length > 0) remainingBulkSmall.push({ sha: group.sha, size: group.size, relPaths: pending });
    }
    await Promise.all([
      runPhase(remainingBulkSmall, this.downloadConcurrency, restoreSmallGroup),
      runPhase([...bulkLarge.values()], COPY_IN_LARGE_BLOB_CONCURRENCY, restoreLargeGroup),
    ]);

    const symlinks = [...symlinkEntries].map(([relPath, entry], index) => ({ relPath, entry, ordinal: index + 1 }));
    if (symlinks.length > 0) {
      reportTrace("symlink-phase-started");
      await forEachBounded(symlinks, this.downloadConcurrency, async (symlinkEntry) => {
        symlinksStarted += 1;
        reportTrace("symlink-entry-started", { symlinkOrdinal: symlinkEntry.ordinal });
        const restored = await restoreSymlink(symlinkEntry.relPath, symlinkEntry.entry, symlinkEntry.ordinal);
        symlinksCompleted += 1;
        reportTrace("symlink-entry-finished", { symlinkOrdinal: symlinkEntry.ordinal, symlinkOutcome: restored ? "restored" : "failed" });
      });
      reportTrace("symlink-phase-finished");
    }

    return { manifestEntries: manifest.size, files, bytes, verified, failures };
  }
}

/**
 * Where a manifest path lands, or nothing when it is not a safe place to write: absolute, empty, `.`, `..`, or resolving
 * outside the root (which the relative check catches after normalisation).
 */
export function resolveRestoreDestination(args: { targetRoot: string; relPath: string }): string | undefined {
  const { targetRoot, relPath } = args;
  if (relPath.length === 0 || isAbsolute(relPath)) return undefined;
  const segments = relPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined;
  const destPath = resolve(targetRoot, relPath);
  const rel = relative(targetRoot, destPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return destPath;
}

/** A symlink is only restored when what it points at is inside the root: a link out of the box is not a restore. */
export function symlinkTargetStaysWithinRoot(args: { targetRoot: string; destPath: string; target: string }): boolean {
  const { targetRoot, destPath, target } = args;
  const targetPath = isAbsolute(target) ? resolve(target) : resolve(dirname(destPath), target);
  const rel = relative(targetRoot, targetPath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * A byte budget for blobs in flight: a caller acquires before fetching and releases after, and an acquisition that would
 * exceed the budget waits for the ones in flight. A single blob larger than the budget is admitted on its own, because a
 * budget that can deadlock is worse than one that is briefly exceeded.
 */
export function makeInFlightByteBudget(budgetBytes: number): BoxStoreByteBudget {
  let inFlightBytes = 0;
  const waiters: Array<{ bytes: number; admit(): void }> = [];
  const admitWaiters = (): void => {
    while (waiters.length > 0) {
      const head = waiters[0];
      if (head == null || (inFlightBytes > 0 && inFlightBytes + head.bytes > budgetBytes)) break;
      waiters.shift();
      inFlightBytes += head.bytes;
      head.admit();
    }
  };
  return {
    async acquire(byteCount) {
      if (byteCount <= 0) return;
      if (waiters.length === 0 && (inFlightBytes === 0 || inFlightBytes + byteCount <= budgetBytes)) {
        inFlightBytes += byteCount;
        return;
      }
      await new Promise<void>((admit) => waiters.push({ bytes: byteCount, admit }));
    },
    release(byteCount) {
      if (byteCount <= 0) return;
      inFlightBytes = Math.max(0, inFlightBytes - byteCount);
      admitWaiters();
    },
  };
}

/** A file's hash, read through a no-follow handle so a path that became a link is refused rather than followed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new BoxStoreSyncError("hash source is not a regular file");
    await pipeline(handle.createReadStream({ autoClose: false }), hash);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Copies a file while hashing it, so the copy and its verification are the same read. */
export async function copyFileHashing(srcPath: string, destPath: string): Promise<{ sha: string; size: number; mode: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      size += buffer.byteLength;
      callback(null, buffer);
    },
  });
  const handle = await open(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new BoxStoreSyncError("copy source is not a regular file");
    await pipeline(handle.createReadStream({ autoClose: false }), tap, createWriteStream(destPath, { flags: "wx" }));
    return { sha: hash.digest("hex"), size, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}
