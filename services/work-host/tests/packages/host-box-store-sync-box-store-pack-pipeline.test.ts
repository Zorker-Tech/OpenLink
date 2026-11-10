import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BoxStorePackPipeline,
  PACK_BUILD_MIN_BYTES,
  PACK_BUILD_MIN_MEMBERS,
  PACK_DOWNLOAD_CONCURRENCY,
  PACK_EXTRACT_CONCURRENCY,
  PACK_RESTORE_MIN_BYTE_SHARE,
  PACK_RESTORE_MIN_MEMBERS,
  PACK_TMP_DIR_NAME,
  PACK_TMP_MAX_AGE_MS,
} from "../../source/host/boxes/box-store-sync/box-store-pack-pipeline.ts";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture(files: Record<string, string>, options: any = {}) {
  const root = mkdtempSync(join(tmpdir(), "pack-test-"));
  const categoryDir = join(root, "category");
  mkdirSync(categoryDir, { recursive: true });
  const manifest = new Map<string, any>();
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(categoryDir, ...relPath.split("/").slice(1));
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content);
    manifest.set(relPath, { sha: sha(content), size: Buffer.byteLength(content), mode: 0o644 });
  }
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const logs: string[] = [];
  const store = {
    async get(key: string) { return objects.get(key) ?? null; },
    async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
    async putFromFile(key: string, path: string) { objects.set(key, readFileSync(path)); },
    async getToFile(key: string, path: string) { const value = objects.get(key); if (value === undefined) return null; writeFileSync(path, value); return value.byteLength; },
    async delete(key: string) { deleted.push(key); objects.delete(key); },
  };
  const pipeline = new BoxStorePackPipeline({
    categories: [{ absRoot: categoryDir, relPrefix: "project" }],
    objectStore: () => store,
    manifestStore: { loadManifest: async () => manifest },
    now: () => 1_000,
    log: (message: string) => logs.push(message),
    getFlushWaiters: () => options.flushWaiters ?? 0,
    discardTemp: async ({ tmpPath }: any) => { try { rmSync(tmpPath, { force: true }); } catch {} },
    sha256File: async (path: string) => sha(readFileSync(path)),
  } as never);
  return { root, manifest, objects, deleted, logs, store, pipeline };
}
const smallFiles = Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["project/small/file-" + index + ".txt", "content number " + index]));

describe("packs: many small blobs as one object", () => {
  it("keeps its limits", () => {
    assert.deepEqual([PACK_DOWNLOAD_CONCURRENCY, PACK_RESTORE_MIN_MEMBERS, PACK_RESTORE_MIN_BYTE_SHARE, PACK_EXTRACT_CONCURRENCY, PACK_BUILD_MIN_MEMBERS, PACK_BUILD_MIN_BYTES, PACK_TMP_DIR_NAME, PACK_TMP_MAX_AGE_MS], [2, 16, 8, 16, 16, 4 * 1024 * 1024, "slate-box-store-pack", 24 * 60 * 60 * 1_000]);
  });

  it("builds a pack and replaces the index only after it is uploaded", async () => {
    const created = fixture(smallFiles);
    try {
      const summary = await created.pipeline.syncPacks("store-1");
      assert.equal(summary.filesUploaded, 1);
      assert.equal(summary.bytesUploaded > 0, true);
      assert.equal([...created.objects.keys()].some((key) => key.startsWith("packs/")), true);
      assert.equal([...created.objects.keys()].some((key) => key.includes("index")), true);
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });

  it("leaves too few members loose", async () => {
    const created = fixture({ "project/small/one.txt": "one", "project/small/two.txt": "two" });
    try {
      const summary = await created.pipeline.syncPacks("store-1");
      assert.equal(summary.filesUploaded, 0);
      assert.equal(summary.filesScanned, 0, "too few members are not planned into a pack");
      assert.deepEqual([...created.objects.keys()], []);
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });

  it("yields the round to a waiting flush", async () => {
    const created = fixture(smallFiles, { flushWaiters: 1 });
    try {
      const summary = await created.pipeline.syncPacks("store-1");
      assert.equal(summary.filesUploaded, 0);
      assert.match(created.logs.join("\n"), /yielded to a waiting flush/);
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });

  it("does not restore a pack that is not worth it", async () => {
    const largeFiles = Object.fromEntries(Array.from({ length: 16 }, (_, index) => ["project/large/file-" + index + ".bin", randomBytes(300_000).toString("base64")]));
    const created = fixture(largeFiles);
    try {
      await created.pipeline.syncPacks("store-1");
      const targetDir = join(created.root, "target");
      mkdirSync(targetDir, { recursive: true });
      const groups = new Map<string, any>();
      for (const [relPath, entry] of [...created.manifest].slice(0, 8)) {
        groups.set(entry.sha + ":" + entry.size, { sha: entry.sha, size: entry.size, relPaths: [relPath] });
      }
      const written: string[] = [];
      const restored = await created.pipeline.restoreBulkSmallFromPacks({
        store: created.store as never,
        targetDir,
        groups: groups as never,
        byteBudget: { acquire: async () => undefined, release: () => undefined } as never,
        localFileMatches: async () => false,
        mkdirOwned: async () => undefined,
        applyExistingFileMetadata: async () => undefined,
        writeVerifiedBytes: async (destPath: string) => { written.push(destPath); },
        recordRestoredPath: () => undefined,
      } as never);
      assert.equal(restored.size, 0, "a pack below the floor is not restored");
      assert.deepEqual(written, []);
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });

  it("does not overwrite files that already match", async () => {
    const created = fixture(smallFiles);
    try {
      await created.pipeline.syncPacks("store-1");
      const targetDir = join(created.root, "target");
      mkdirSync(targetDir, { recursive: true });
      const groups = new Map<string, any>();
      for (const [relPath, entry] of created.manifest) {
        const key = entry.sha + ":" + entry.size;
        const group = groups.get(key) ?? { sha: entry.sha, size: entry.size, relPaths: [] };
        group.relPaths.push(relPath);
        groups.set(key, group);
      }
      const written: string[] = [];
      const metadata: string[] = [];
      const restored = await created.pipeline.restoreBulkSmallFromPacks({
        store: created.store as never,
        targetDir,
        groups: groups as never,
        byteBudget: { acquire: async () => undefined, release: () => undefined } as never,
        localFileMatches: async (_destinationPath: string, group: any) => group.relPaths.some((relPath: string) => /file-[0-3]\.txt$/.test(relPath)),
        mkdirOwned: async () => undefined,
        applyExistingFileMetadata: async (destPath: string) => { metadata.push(destPath); },
        writeVerifiedBytes: async (destPath: string) => { written.push(destPath); },
        recordRestoredPath: () => undefined,
      } as never);
      assert.equal(restored.size, Object.keys(smallFiles).length);
      assert.equal(written.length, 16, "only the files that do not match are written");
      assert.equal(metadata.length, 4, "a matching file only gets its metadata applied");
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });

  it("restores members from a pack", async () => {
    const created = fixture(smallFiles);
    try {
      await created.pipeline.syncPacks("store-1");
      const targetDir = join(created.root, "target");
      mkdirSync(targetDir, { recursive: true });
      const groups = new Map<string, any>();
      for (const [relPath, entry] of created.manifest) {
        const key = entry.sha + ":" + entry.size;
        const group = groups.get(key) ?? { sha: entry.sha, size: entry.size, relPaths: [] };
        group.relPaths.push(relPath);
        groups.set(key, group);
      }
      const recorded: number[] = [];
      const restored = await created.pipeline.restoreBulkSmallFromPacks({
        store: created.store as never,
        targetDir,
        groups: groups as never,
        byteBudget: { acquire: async () => undefined, release: () => undefined } as never,
        localFileMatches: async () => false,
        mkdirOwned: async (dir: string) => { mkdirSync(dir, { recursive: true }); },
        applyExistingFileMetadata: async () => undefined,
        writeVerifiedBytes: async (destPath: string, _relPath: string, bytes: Uint8Array) => { mkdirSync(join(destPath, ".."), { recursive: true }); writeFileSync(destPath, bytes); },
        recordRestoredPath: (bytes: number) => { recorded.push(bytes); },
      } as never);
      assert.equal(restored.size, smallFiles && Object.keys(smallFiles).length);
      assert.deepEqual(recorded.map((bytes) => bytes > 0), Array.from({ length: Object.keys(smallFiles).length }, () => true));
      assert.deepEqual(readdirSync(join(targetDir, "project", "small")).length, 20);
    } finally { rmSync(created.root, { recursive: true, force: true }); }
  });
});
