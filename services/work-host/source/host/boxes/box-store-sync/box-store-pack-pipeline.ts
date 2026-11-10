/**
 * Packs: carrying many small blobs as one object.
 *
 * A store with a thousand small files costs a thousand reads to restore. A pack is the answer — many members in one file,
 * with an index that says where each member is — and this file owns the two sides of it:
 *
 * - **building** — decide which liveSizes blobs are worth packing (small enough, present locally, not already packed), build
 *   them, upload each pack by content, and only then replace the index. A round that finds a flush waiting yields, because
 *   a user asking for "clock" outranks housekeeping;
 * - **restoring** — a pack is only used when it saves real work (enough members, and its bytes are mostly wanted);
 *   members are verified as they are extracted, and anything that does not verify falls back to the loose blob.
 *
 * The retired list is the tombstone side of the index: a pack that is no longer keptIds is recorded before it is
 * deleted, so an interrupted deletion leaves a pack the next restore knows to ignore rather than a dangling reference.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forEachBounded } from "../box-transfer.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { isBoxStoreManifestFileEntry } from "./box-store-manifest-format.ts";
import type { BoxStoreManifestStore } from "./box-store-manifest.ts";
import type { BoxObjectStore } from "./box-object-store.ts";
import {
  BOX_STORE_PACK_INDEX_KEY,
  BOX_STORE_PACK_RETIRED_KEY,
  BOX_STORE_PACKS_PREFIX,
  PACK_INDEX_MAX_BYTES,
  PACK_MAX_MEMBER_SIZE_SUM,
  PACK_MEMBER_MAX_BYTES,
  buildPackFile,
  extractPackMembers,
  parsePackIndex,
  parsePackRetired,
  planPackMaintenance,
  serializePackIndex,
  serializePackRetired,
  type PackEntry,
} from "./box-store-pack.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";

export const PACK_DOWNLOAD_CONCURRENCY = 2;
/** A pack is only worth restoring when it saves enough work: this many members, or this share of its bytes. */
export const PACK_RESTORE_MIN_MEMBERS = 16;
export const PACK_RESTORE_MIN_BYTE_SHARE = 8;
export const PACK_EXTRACT_CONCURRENCY = 16;
export const PACK_BUILD_MIN_MEMBERS = PACK_RESTORE_MIN_MEMBERS;
export const PACK_BUILD_MIN_BYTES = 4 * 1024 * 1024;
export const PACK_TMP_DIR_NAME = "slate-box-store-pack";
/** A temporary older than a day is a leftover from a host that died: no pack build takes that long. */
export const PACK_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface BoxStorePackCategory {
  readonly absRoot: string;
  readonly relPrefix: string;
  readonly stageOnly?: boolean;
}

export interface BoxStoreBlobGroup {
  readonly sha: string;
  readonly size: number;
  readonly relPaths: string[];
}

export interface BoxStoreByteBudget {
  acquire(byteCount: number): Promise<void>;
  release(byteCount: number): void;
}

export interface BoxStorePackCycleSummary {
  readonly name: "packs";
  filesScanned: number;
  filesUploaded: number;
  bytesUploaded: number;
  skippedUnchanged: number;
  removed: number;
  oversize: number;
  failures: number;
  metadataFailures: number;
}

export interface BoxStorePackPipelineOptions {
  readonly categories: readonly BoxStorePackCategory[];
  objectStore(storeId: string): BoxObjectStore;
  readonly manifestStore: Pick<BoxStoreManifestStore, "loadManifest">;
  now(): number;
  log(message: string): void;
  getFlushWaiters(): number;
  discardTemp(input: { tmpPath: string; label: string }): Promise<void>;
  sha256File(path: string): Promise<string>;
}

export interface RestoreBulkSmallFromPacksOptions {
  readonly store: BoxObjectStore;
  readonly targetDir: string;
  readonly groups: ReadonlyMap<string, BoxStoreBlobGroup>;
  readonly byteBudget: BoxStoreByteBudget;
  localFileMatches(destinationPath: string, group: BoxStoreBlobGroup): Promise<boolean>;
  mkdirOwned(dir: string): Promise<void>;
  applyExistingFileMetadata(destinationPath: string, relPath: string): Promise<void>;
  writeVerifiedBytes(destinationPath: string, relPath: string, bytes: Uint8Array): Promise<void>;
  recordRestoredPath(byteSize: number): void;
}

export class BoxStorePackPipeline {
  private readonly categories: readonly BoxStorePackCategory[];
  private readonly objectStore: (storeId: string) => BoxObjectStore;
  private readonly manifestStore: Pick<BoxStoreManifestStore, "loadManifest">;
  private readonly clock: () => number;
  private readonly log: (message: string) => void;
  private readonly getFlushWaiters: () => number;
  private readonly discardTemp: (input: { tmpPath: string; label: string }) => Promise<void>;
  private readonly sha256File: (path: string) => Promise<string>;

  constructor(input: BoxStorePackPipelineOptions) {
    this.categories = input.categories;
    this.objectStore = input.objectStore;
    this.manifestStore = input.manifestStore;
    this.clock = input.now;
    this.log = input.log;
    this.getFlushWaiters = input.getFlushWaiters;
    this.discardTemp = input.discardTemp;
    this.sha256File = input.sha256File;
  }

  /** Where a stored path lives on this box: the most specific rootCategory that names it wins. */
  resolveLocalPathForRelPath(relPath: string): string | undefined {
    let mostSpecific: BoxStorePackCategory | undefined;
    for (const rootCategory of this.categories) {
      if (rootCategory.stageOnly) continue;
      if (!relPath.startsWith(`${rootCategory.relPrefix}/`)) continue;
      if (mostSpecific == null || rootCategory.relPrefix.length > mostSpecific.relPrefix.length) mostSpecific = rootCategory;
    }
    if (mostSpecific == null) return undefined;
    return join(mostSpecific.absRoot, ...relPath.slice(mostSpecific.relPrefix.length + 1).split("/"));
  }

  /** The pack scratch directory, swept of leftovers from a host that died mid-build. */
  async ensureSweptPackTmpDir(): Promise<string> {
    const dir = join(tmpdir(), PACK_TMP_DIR_NAME);
    await mkdir(dir, { recursive: true });
    try {
      const clock = this.clock();
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        try {
          const fileInfo = await stat(path);
          if (clock - fileInfo.mtimeMs > PACK_TMP_MAX_AGE_MS) await unlink(path);
        } catch {
          // A leftover that vanished while it was being swept is already gone.
        }
      }
    } catch {
      // The directory exists; a concurrent change must not fail the round.
    }
    return dir;
  }

  /** One maintenance round: decide, build, upload, then replace the index (and only then retire the old packs). */
  async syncPacks(storeId: string): Promise<BoxStorePackCycleSummary> {
    const cycleSummary: BoxStorePackCycleSummary = { name: "packs", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 };
    try {
      const store = this.objectStore(storeId);
      const manifest = await this.manifestStore.loadManifest(storeId);
      const liveSizes = new Map<string, number>();
      const packable = new Map<string, number>();
      const pathBySha = new Map<string, string>();

      for (const [relPath, entry] of manifest) {
        if (!isBoxStoreManifestFileEntry(entry)) continue;
        liveSizes.set(entry.sha, entry.size);
        // Too big to be a pack member, or a blob a pack already holds: not a candidate for a new pack.
        if (entry.size >= PACK_MEMBER_MAX_BYTES || packable.has(entry.sha)) continue;
        const absPath = this.resolveLocalPathForRelPath(relPath);
        if (absPath == null) continue;
        try {
          const fileInfo = await lstat(absPath);
          if (!fileInfo.isFile() || fileInfo.size !== entry.size) continue;
        } catch {
          continue;
        }
        packable.set(entry.sha, entry.size);
        pathBySha.set(entry.sha, absPath);
      }

      const rawPackIndex = await store.get(BOX_STORE_PACK_INDEX_KEY);
      const index = rawPackIndex == null || rawPackIndex.byteLength > PACK_INDEX_MAX_BYTES ? null : parsePackIndex(Buffer.from(rawPackIndex).toString("utf8"));
      if (rawPackIndex != null && index == null) this.log("the pack index is unparseable; rebuilding it from scratch");

      const maintenancePlan = planPackMaintenance({
        live: liveSizes,
        eligible: packable,
        index,
        maxPackMemberSizeSum: PACK_MAX_MEMBER_SIZE_SUM,
        minPackMembers: PACK_BUILD_MIN_MEMBERS,
        minPackBytes: PACK_BUILD_MIN_BYTES,
      });
      cycleSummary.skippedUnchanged = maintenancePlan.keptPacks.length;
      cycleSummary.removed = maintenancePlan.retiredPackIds.length;
      cycleSummary.filesScanned = maintenancePlan.newPacks.length;
      if (maintenancePlan.newPacks.length === 0 && maintenancePlan.retiredPackIds.length === 0) return cycleSummary;

      // Housekeeping yields to a flush: a user waiting for their store comes before a pack build.
      const yieldToFlush = (): boolean => this.getFlushWaiters() > 0;
      const scratchDir = await this.ensureSweptPackTmpDir();
      const newPackEntries: PackEntry[] = [];

      for (const plannedPack of maintenancePlan.newPacks) {
        if (yieldToFlush()) {
          this.log("the pack round yielded to a waiting flush; it will be retried later");
          return cycleSummary;
        }
        const tempPath = join(scratchDir, `build-${randomBytes(8).toString("hex")}`);
        try {
          const builtPack = await buildPackFile(
            tempPath,
            plannedPack.flatMap((member) => {
              const absPath = pathBySha.get(member.sha);
              return absPath == null ? [] : [{ ...member, absPath }];
            }),
            yieldToFlush,
          );
          if (builtPack == null) {
            this.log("the pack round yielded to a waiting flush; it will be retried later");
            return cycleSummary;
          }
          if (builtPack.members.length === 0) continue;
          const builtByteSum = builtPack.members.reduce((sum, member) => sum + member.size, 0);
          // Below the floor a pack costs more than it saves: the members go back to being loose blobs.
          if (builtPack.members.length < PACK_BUILD_MIN_MEMBERS && builtByteSum < PACK_BUILD_MIN_BYTES) continue;

          const newPackId = await this.sha256File(tempPath);
          await store.putFromFile!(`${BOX_STORE_PACKS_PREFIX}/${newPackId}`, tempPath, newPackId, builtPack.fileBytes);
          newPackEntries.push({ id: newPackId, bytes: builtPack.fileBytes, members: [...builtPack.members] });
          cycleSummary.filesUploaded += 1;
          cycleSummary.bytesUploaded += builtPack.fileBytes;
        } finally {
          await this.discardTemp({ tmpPath: tempPath, label: "pack build" });
        }
      }

      if (yieldToFlush()) {
        this.log("the pack round yielded to a waiting flush; it will be retried later");
        return cycleSummary;
      }
      if (newPackEntries.length === 0 && maintenancePlan.retiredPackIds.length === 0) return cycleSummary;

      const nextPackIndex = {
        version: 1,
        maxVmtime: Math.max(index?.maxVmtime ?? 0, ...newPackEntries.flatMap((pack) => pack.members.map((member) => member.vmtime))),
        packs: [...maintenancePlan.keptPacks, ...newPackEntries],
      };
      const keptIds = new Set(nextPackIndex.packs.map((pack) => pack.id));
      const retiringIds = maintenancePlan.retiredPackIds.filter((id) => !keptIds.has(id));

      try {
        const rawRetiredList = await store.get(BOX_STORE_PACK_RETIRED_KEY);
        const existingTombstones = rawRetiredList == null ? [] : parsePackRetired(Buffer.from(rawRetiredList).toString("utf8"));
        if (existingTombstones == null) {
          // A retired list that cannot be read is only fatal when something is about to be retired: overwriting it would
          // lose the tombstones of packs a liveSizes index may still name.
          if (retiringIds.length > 0) throw new BoxStoreSyncError("the retired list is present but unreadable; refusing to overwrite it");
          this.log("the retired list is unreadable; continuing without a tombstone update (nothing is retiringIds)");
        } else {
          const mergedIds = [...new Set([...existingTombstones, ...retiringIds])].filter((id) => !keptIds.has(id));
          const listChanged = mergedIds.length !== existingTombstones.length || mergedIds.some((id, indexInExisting) => existingTombstones[indexInExisting] !== id);
          if (listChanged) await store.put(BOX_STORE_PACK_RETIRED_KEY, new Uint8Array(Buffer.from(serializePackRetired(mergedIds), "utf8")));
        }
      } catch (failure) {
        this.log(`the retired-list write failed: ${errorMessage(failure)}`);
        cycleSummary.failures += 1;
        return cycleSummary;
      }

      await store.put(BOX_STORE_PACK_INDEX_KEY, new Uint8Array(Buffer.from(serializePackIndex(nextPackIndex), "utf8")));
      for (const newPackId of retiringIds) {
        try {
          await store.delete(`${BOX_STORE_PACKS_PREFIX}/${newPackId}`);
        } catch {
          // The tombstone is what makes a failed deletion safe: the next restore ignores the pack either way.
        }
      }
      if (maintenancePlan.deferredMembers > 0) this.log(`the pack round deferred ${maintenancePlan.deferredMembers} member(s) under the build floor`);
    } catch (failure) {
      this.log(`the pack maintenance round failed: ${errorMessage(failure)}`);
      cycleSummary.failures += 1;
    }
    return cycleSummary;
  }

  /**
   * Restores what it can from packs, and answers with the paths it restored. Anything a pack cannot serve stays for the
   * caller's loose-blob pass: this method never decides that a path is un-restorable.
   */
  async restoreBulkSmallFromPacks(input: RestoreBulkSmallFromPacksOptions): Promise<Set<string>> {
    const { store, targetDir, groups: smallGroups, byteBudget: budget, localFileMatches, mkdirOwned, applyExistingFileMetadata, writeVerifiedBytes, recordRestoredPath } = input;
    const restoredByPack = new Set<string>();
    const ensuredDirs = new Set<string>();
    const ensureDirectory = async (dir: string): Promise<void> => {
      if (ensuredDirs.has(dir)) return;
      await mkdirOwned(dir);
      ensuredDirs.add(dir);
    };

    const restorePack = async (pack: PackEntry): Promise<void> => {
      // Which members of this pack are actually wanted here and clock, and how many bytes that is.
      const wantedMembers: PackEntry["members"] = [];
      let wantedCompressedBytes = 0;
      let wantedBytes = 0;
      for (const member of pack.members) {
        const group = smallGroups.get(`${member.sha}:${member.size}`);
        if (group == null) continue;
        let pending = false;
        for (const relPath of group.relPaths) {
          if (restoredByPack.has(relPath)) continue;
          const destinationPath = join(targetDir, relPath);
          await ensureDirectory(dirname(destinationPath));
          if (await localFileMatches(destinationPath, group)) continue;
          pending = true;
          break;
        }
        if (pending) {
          wantedMembers.push(member);
          wantedCompressedBytes += member.clen;
          wantedBytes += member.size;
        }
      }
      // Too little of the pack is wanted: downloading it would cost more than fetching those members loose.
      if (wantedMembers.length < PACK_RESTORE_MIN_MEMBERS && wantedBytes < PACK_BUILD_MIN_BYTES) return;
      if (wantedCompressedBytes * PACK_RESTORE_MIN_BYTE_SHARE < pack.bytes) return;

      const tempPath = join(await this.ensureSweptPackTmpDir(), `restore-${randomBytes(8).toString("hex")}`);
      try {
        const written = await store.getToFile!(`${BOX_STORE_PACKS_PREFIX}/${pack.id}`, tempPath, { maxBytes: pack.bytes });
        if (written == null) return;
        const extractResult = await extractPackMembers({
          packPath: tempPath,
          members: pack.members,
          concurrency: PACK_EXTRACT_CONCURRENCY,
          admitBytes: async (memberBytes) => {
            await budget.acquire(memberBytes);
            return () => budget.release(memberBytes);
          },
          wants: (member) => {
            const group = smallGroups.get(`${member.sha}:${member.size}`);
            return group != null && group.relPaths.some((relPath) => !restoredByPack.has(relPath));
          },
          onBlob: async (member, blobBytes) => {
            const group = smallGroups.get(`${member.sha}:${member.size}`);
            if (group == null) return;
            for (const relPath of group.relPaths) {
              if (restoredByPack.has(relPath)) continue;
              restoredByPack.add(relPath);
              const destinationPath = join(targetDir, relPath);
              try {
                await ensureDirectory(dirname(destinationPath));
                if (await localFileMatches(destinationPath, group)) await applyExistingFileMetadata(destinationPath, relPath);
                else await writeVerifiedBytes(destinationPath, relPath, blobBytes);
              } catch {
                // A path that could not be written stays for the loose pass.
                restoredByPack.delete(relPath);
                continue;
              }
              recordRestoredPath(group.size);
            }
          },
        });
        if (extractResult.mismatched > 0) this.log(`pack ${pack.id}: ${extractResult.mismatched} member(s) failed the sha check; those fall back to loose blobs`);
      } finally {
        await this.discardTemp({ tmpPath: tempPath, label: `pack ${pack.id}` });
      }
    };

    if (smallGroups.size > 0) {
      let packIndex = null;
      try {
        const rawPackIndex = await store.get(BOX_STORE_PACK_INDEX_KEY);
        packIndex = rawPackIndex == null || rawPackIndex.byteLength > PACK_INDEX_MAX_BYTES ? null : parsePackIndex(Buffer.from(rawPackIndex).toString("utf8"));
      } catch (failure) {
        this.log(`the pack index could not be read (falling back to loose blobs): ${errorMessage(failure)}`);
      }
      if (packIndex != null && packIndex.packs.length > 0) {
        await forEachBounded([...packIndex.packs], PACK_DOWNLOAD_CONCURRENCY, async (pack) => {
          try {
            await restorePack(pack);
          } catch (failure) {
            this.log(`pack ${pack.id} could not be restored (falling back to loose blobs): ${errorMessage(failure)}`);
          }
        });
      }
    }
    return restoredByPack;
  }
}
