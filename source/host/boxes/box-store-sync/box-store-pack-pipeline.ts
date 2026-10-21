/**
 * Packs: carrying many small blobs as one object.
 *
 * A store with a thousand small files costs a thousand reads to restore. A pack is the answer — many members in one file,
 * with an index that says where each member is — and this file owns the two sides of it:
 *
 * - **building** — decide which live blobs are worth packing (small enough, present locally, not already packed), build
 *   them, upload each pack by content, and only then replace the index. A round that finds a flush waiting yields, because
 *   a user asking for "now" outranks housekeeping;
 * - **restoring** — a pack is only used when it saves real work (enough members, and its bytes are mostly wanted);
 *   members are verified as they are extracted, and anything that does not verify falls back to the loose blob.
 *
 * The retired list is the tombstone side of the index: a pack that is no longer referenced is recorded before it is
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
  discardTemp(args: { tmpPath: string; label: string }): Promise<void>;
  sha256File(path: string): Promise<string>;
}

export interface RestoreBulkSmallFromPacksOptions {
  readonly store: BoxObjectStore;
  readonly targetDir: string;
  readonly groups: ReadonlyMap<string, BoxStoreBlobGroup>;
  readonly byteBudget: BoxStoreByteBudget;
  localFileMatches(destPath: string, group: BoxStoreBlobGroup): Promise<boolean>;
  mkdirOwned(dir: string): Promise<void>;
  applyExistingFileMetadata(destPath: string, relPath: string): Promise<void>;
  writeVerifiedBytes(destPath: string, relPath: string, bytes: Uint8Array): Promise<void>;
  recordRestoredPath(byteSize: number): void;
}

export class BoxStorePackPipeline {
  private readonly categories: readonly BoxStorePackCategory[];
  private readonly objectStore: (storeId: string) => BoxObjectStore;
  private readonly manifestStore: Pick<BoxStoreManifestStore, "loadManifest">;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly getFlushWaiters: () => number;
  private readonly discardTemp: (args: { tmpPath: string; label: string }) => Promise<void>;
  private readonly sha256File: (path: string) => Promise<string>;

  constructor(args: BoxStorePackPipelineOptions) {
    this.categories = args.categories;
    this.objectStore = args.objectStore;
    this.manifestStore = args.manifestStore;
    this.now = args.now;
    this.log = args.log;
    this.getFlushWaiters = args.getFlushWaiters;
    this.discardTemp = args.discardTemp;
    this.sha256File = args.sha256File;
  }

  /** Where a stored path lives on this box: the most specific category that names it wins. */
  resolveLocalPathForRelPath(relPath: string): string | undefined {
    let best: BoxStorePackCategory | undefined;
    for (const category of this.categories) {
      if (category.stageOnly) continue;
      if (!relPath.startsWith(`${category.relPrefix}/`)) continue;
      if (best == null || category.relPrefix.length > best.relPrefix.length) best = category;
    }
    if (best == null) return undefined;
    return join(best.absRoot, ...relPath.slice(best.relPrefix.length + 1).split("/"));
  }

  /** The pack scratch directory, swept of leftovers from a host that died mid-build. */
  async ensureSweptPackTmpDir(): Promise<string> {
    const dir = join(tmpdir(), PACK_TMP_DIR_NAME);
    await mkdir(dir, { recursive: true });
    try {
      const now = this.now();
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > PACK_TMP_MAX_AGE_MS) await unlink(path);
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
    const summary: BoxStorePackCycleSummary = { name: "packs", filesScanned: 0, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 };
    try {
      const store = this.objectStore(storeId);
      const manifest = await this.manifestStore.loadManifest(storeId);
      const live = new Map<string, number>();
      const eligible = new Map<string, number>();
      const localBySha = new Map<string, string>();

      for (const [relPath, entry] of manifest) {
        if (!isBoxStoreManifestFileEntry(entry)) continue;
        live.set(entry.sha, entry.size);
        // Too big to be a pack member, or a blob a pack already holds: not a candidate for a new pack.
        if (entry.size >= PACK_MEMBER_MAX_BYTES || eligible.has(entry.sha)) continue;
        const absPath = this.resolveLocalPathForRelPath(relPath);
        if (absPath == null) continue;
        try {
          const info = await lstat(absPath);
          if (!info.isFile() || info.size !== entry.size) continue;
        } catch {
          continue;
        }
        eligible.set(entry.sha, entry.size);
        localBySha.set(entry.sha, absPath);
      }

      const rawIndex = await store.get(BOX_STORE_PACK_INDEX_KEY);
      const index = rawIndex == null || rawIndex.byteLength > PACK_INDEX_MAX_BYTES ? null : parsePackIndex(Buffer.from(rawIndex).toString("utf8"));
      if (rawIndex != null && index == null) this.log("the pack index is unparseable; rebuilding it from scratch");

      const plan = planPackMaintenance({
        live,
        eligible,
        index,
        maxPackMemberSizeSum: PACK_MAX_MEMBER_SIZE_SUM,
        minPackMembers: PACK_BUILD_MIN_MEMBERS,
        minPackBytes: PACK_BUILD_MIN_BYTES,
      });
      summary.skippedUnchanged = plan.keptPacks.length;
      summary.removed = plan.retiredPackIds.length;
      summary.filesScanned = plan.newPacks.length;
      if (plan.newPacks.length === 0 && plan.retiredPackIds.length === 0) return summary;

      // Housekeeping yields to a flush: a user waiting for their store comes before a pack build.
      const yieldToFlush = (): boolean => this.getFlushWaiters() > 0;
      const tmpDir = await this.ensureSweptPackTmpDir();
      const builtPacks: PackEntry[] = [];

      for (const planned of plan.newPacks) {
        if (yieldToFlush()) {
          this.log("the pack round yielded to a waiting flush; it will be retried later");
          return summary;
        }
        const tmpPath = join(tmpDir, `build-${randomBytes(8).toString("hex")}`);
        try {
          const built = await buildPackFile(
            tmpPath,
            planned.flatMap((member) => {
              const absPath = localBySha.get(member.sha);
              return absPath == null ? [] : [{ ...member, absPath }];
            }),
            yieldToFlush,
          );
          if (built == null) {
            this.log("the pack round yielded to a waiting flush; it will be retried later");
            return summary;
          }
          if (built.members.length === 0) continue;
          const builtSizeSum = built.members.reduce((sum, member) => sum + member.size, 0);
          // Below the floor a pack costs more than it saves: the members go back to being loose blobs.
          if (built.members.length < PACK_BUILD_MIN_MEMBERS && builtSizeSum < PACK_BUILD_MIN_BYTES) continue;

          const packId = await this.sha256File(tmpPath);
          await store.putFromFile!(`${BOX_STORE_PACKS_PREFIX}/${packId}`, tmpPath, packId, built.fileBytes);
          builtPacks.push({ id: packId, bytes: built.fileBytes, members: [...built.members] });
          summary.filesUploaded += 1;
          summary.bytesUploaded += built.fileBytes;
        } finally {
          await this.discardTemp({ tmpPath, label: "pack build" });
        }
      }

      if (yieldToFlush()) {
        this.log("the pack round yielded to a waiting flush; it will be retried later");
        return summary;
      }
      if (builtPacks.length === 0 && plan.retiredPackIds.length === 0) return summary;

      const nextIndex = {
        version: 1,
        maxVmtime: Math.max(index?.maxVmtime ?? 0, ...builtPacks.flatMap((pack) => pack.members.map((member) => member.vmtime))),
        packs: [...plan.keptPacks, ...builtPacks],
      };
      const referenced = new Set(nextIndex.packs.map((pack) => pack.id));
      const retiring = plan.retiredPackIds.filter((id) => !referenced.has(id));

      try {
        const rawRetired = await store.get(BOX_STORE_PACK_RETIRED_KEY);
        const existing = rawRetired == null ? [] : parsePackRetired(Buffer.from(rawRetired).toString("utf8"));
        if (existing == null) {
          // A retired list that cannot be read is only fatal when something is about to be retired: overwriting it would
          // lose the tombstones of packs a live index may still name.
          if (retiring.length > 0) throw new BoxStoreSyncError("the retired list is present but unreadable; refusing to overwrite it");
          this.log("the retired list is unreadable; continuing without a tombstone update (nothing is retiring)");
        } else {
          const merged = [...new Set([...existing, ...retiring])].filter((id) => !referenced.has(id));
          const changed = merged.length !== existing.length || merged.some((id, indexInExisting) => existing[indexInExisting] !== id);
          if (changed) await store.put(BOX_STORE_PACK_RETIRED_KEY, new Uint8Array(Buffer.from(serializePackRetired(merged), "utf8")));
        }
      } catch (error) {
        this.log(`the retired-list write failed: ${errorMessage(error)}`);
        summary.failures += 1;
        return summary;
      }

      await store.put(BOX_STORE_PACK_INDEX_KEY, new Uint8Array(Buffer.from(serializePackIndex(nextIndex), "utf8")));
      for (const packId of retiring) {
        try {
          await store.delete(`${BOX_STORE_PACKS_PREFIX}/${packId}`);
        } catch {
          // The tombstone is what makes a failed deletion safe: the next restore ignores the pack either way.
        }
      }
      if (plan.deferredMembers > 0) this.log(`the pack round deferred ${plan.deferredMembers} member(s) under the build floor`);
    } catch (error) {
      this.log(`the pack maintenance round failed: ${errorMessage(error)}`);
      summary.failures += 1;
    }
    return summary;
  }

  /**
   * Restores what it can from packs, and answers with the paths it restored. Anything a pack cannot serve stays for the
   * caller's loose-blob pass: this method never decides that a path is un-restorable.
   */
  async restoreBulkSmallFromPacks(args: RestoreBulkSmallFromPacksOptions): Promise<Set<string>> {
    const { store, targetDir, groups: bulkSmall, byteBudget, localFileMatches, mkdirOwned, applyExistingFileMetadata, writeVerifiedBytes, recordRestoredPath } = args;
    const restoredByPack = new Set<string>();
    const ensuredDirs = new Set<string>();
    const ensureDir = async (dir: string): Promise<void> => {
      if (ensuredDirs.has(dir)) return;
      await mkdirOwned(dir);
      ensuredDirs.add(dir);
    };

    const restoreFromPack = async (pack: PackEntry): Promise<void> => {
      // Which members of this pack are actually wanted here and now, and how many bytes that is.
      const usable: PackEntry["members"] = [];
      let usableCompressedBytes = 0;
      let usableSize = 0;
      for (const member of pack.members) {
        const group = bulkSmall.get(`${member.sha}:${member.size}`);
        if (group == null) continue;
        let pending = false;
        for (const relPath of group.relPaths) {
          if (restoredByPack.has(relPath)) continue;
          const destPath = join(targetDir, relPath);
          await ensureDir(dirname(destPath));
          if (await localFileMatches(destPath, group)) continue;
          pending = true;
          break;
        }
        if (pending) {
          usable.push(member);
          usableCompressedBytes += member.clen;
          usableSize += member.size;
        }
      }
      // Too little of the pack is wanted: downloading it would cost more than fetching those members loose.
      if (usable.length < PACK_RESTORE_MIN_MEMBERS && usableSize < PACK_BUILD_MIN_BYTES) return;
      if (usableCompressedBytes * PACK_RESTORE_MIN_BYTE_SHARE < pack.bytes) return;

      const tmpPath = join(await this.ensureSweptPackTmpDir(), `restore-${randomBytes(8).toString("hex")}`);
      try {
        const written = await store.getToFile!(`${BOX_STORE_PACKS_PREFIX}/${pack.id}`, tmpPath, { maxBytes: pack.bytes });
        if (written == null) return;
        const result = await extractPackMembers({
          packPath: tmpPath,
          members: pack.members,
          concurrency: PACK_EXTRACT_CONCURRENCY,
          admitBytes: async (memberBytes) => {
            await byteBudget.acquire(memberBytes);
            return () => byteBudget.release(memberBytes);
          },
          wants: (member) => {
            const group = bulkSmall.get(`${member.sha}:${member.size}`);
            return group != null && group.relPaths.some((relPath) => !restoredByPack.has(relPath));
          },
          onBlob: async (member, blobBytes) => {
            const group = bulkSmall.get(`${member.sha}:${member.size}`);
            if (group == null) return;
            for (const relPath of group.relPaths) {
              if (restoredByPack.has(relPath)) continue;
              restoredByPack.add(relPath);
              const destPath = join(targetDir, relPath);
              try {
                await ensureDir(dirname(destPath));
                if (await localFileMatches(destPath, group)) await applyExistingFileMetadata(destPath, relPath);
                else await writeVerifiedBytes(destPath, relPath, blobBytes);
              } catch {
                // A path that could not be written stays for the loose pass.
                restoredByPack.delete(relPath);
                continue;
              }
              recordRestoredPath(group.size);
            }
          },
        });
        if (result.mismatched > 0) this.log(`pack ${pack.id}: ${result.mismatched} member(s) failed the sha check; those fall back to loose blobs`);
      } finally {
        await this.discardTemp({ tmpPath, label: `pack ${pack.id}` });
      }
    };

    if (bulkSmall.size > 0) {
      let packIndex = null;
      try {
        const rawIndex = await store.get(BOX_STORE_PACK_INDEX_KEY);
        packIndex = rawIndex == null || rawIndex.byteLength > PACK_INDEX_MAX_BYTES ? null : parsePackIndex(Buffer.from(rawIndex).toString("utf8"));
      } catch (error) {
        this.log(`the pack index could not be read (falling back to loose blobs): ${errorMessage(error)}`);
      }
      if (packIndex != null && packIndex.packs.length > 0) {
        await forEachBounded([...packIndex.packs], PACK_DOWNLOAD_CONCURRENCY, async (pack) => {
          try {
            await restoreFromPack(pack);
          } catch (error) {
            this.log(`pack ${pack.id} could not be restored (falling back to loose blobs): ${errorMessage(error)}`);
          }
        });
      }
    }
    return restoredByPack;
  }
}
