import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BoxObjectStore, BoxObjectStoreProvider } from "../../source/host/boxes/box-store-sync/box-object-store.ts";
import { BoxStoreManifestStore, type BoxManifestMap } from "../../source/host/boxes/box-store-sync/box-store-manifest.ts";
import { boxStoreManifestEntriesEqual, type BoxStoreManifestEntry } from "../../source/host/boxes/box-store-sync/box-store-manifest-format.ts";
import { BoxStoreTransfer, type BoxStoreTransferCategory } from "../../source/host/boxes/box-store-sync/box-store-transfer.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "slate-box-store-transfer-"));
  return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

function transferWorld(
  root: string,
  options: { readonly maxObjectBytes?: number; readonly largeObjectThreshold?: number; readonly freeDiskBytes?: number } = {},
) {
  const manifest: BoxManifestMap = new Map();
  const smallWrites: Array<{ key: string; bytes: Uint8Array }> = [];
  const fileWrites: Array<{ key: string; path: string; sha: string; size: number; bytes: Uint8Array }> = [];
  const stored = new Map<string, Uint8Array>();
  const objectStore: BoxObjectStore = {
    async get(key) { return stored.get(key) ?? null; },
    async put(key, bytes) {
      const copy = Uint8Array.from(bytes);
      smallWrites.push({ key, bytes: copy });
      stored.set(key, copy);
    },
    async putFromFile(key, sourcePath, digest, size) {
      const bytes = new Uint8Array(await import("node:fs/promises").then(({ readFile }) => readFile(sourcePath)));
      fileWrites.push({ key, path: sourcePath, sha: digest, size, bytes });
      stored.set(key, bytes);
    },
    async list() { return []; },
    async delete(key) { stored.delete(key); },
  };
  const provider: BoxObjectStoreProvider = { forStore: () => objectStore };
  const manifestStore = {
    async loadManifest() { return manifest; },
    setManifestEntry(target: BoxManifestMap, path: string, entry: BoxStoreManifestEntry) {
      const changed = !boxStoreManifestEntriesEqual(target.get(path), entry);
      target.set(path, entry);
      return changed;
    },
    deleteManifestEntry(target: BoxManifestMap, path: string) { return target.delete(path); },
  } as unknown as BoxStoreManifestStore;
  const transfer = new BoxStoreTransfer({
    deps: {
      categories: [],
      objectStoreProvider: provider,
      resolveStoreId: async () => "store-1",
      readFreeDiskBytes: async () => options.freeDiskBytes ?? 10_000_000,
    },
    now: () => 1,
    log: () => {},
    manifestStore,
    maxObjectBytes: options.maxObjectBytes ?? 1_000_000,
    downloadConcurrency: 1,
    uploadConcurrency: 1,
    largeObjectThreshold: options.largeObjectThreshold ?? 1_000_000,
    downloadByteBudget: 1_000_000,
    getFlushWaiters: () => 0,
  });
  return { transfer, manifest, smallWrites, fileWrites, stored };
}

const fileFacts = (path: string) => {
  const value = statSync(path);
  return { mtimeMs: value.mtimeMs, size: value.size, mode: value.mode };
};

test("small-file sync writes content-addressed bytes once, then uses the stat cache", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "note.txt");
    const content = Buffer.from("a small note");
    writeFileSync(filePath, content);
    const world = transferWorld(root);
    const facts = fileFacts(filePath);

    const first = await world.transfer.syncFile("store-1", world.manifest, "data/note.txt", filePath, facts);
    assert.equal(first, "uploaded");
    assert.deepEqual(world.smallWrites.map((write) => write.key), [`blobs/${sha(content)}`]);
    assert.deepEqual(Array.from(world.smallWrites[0]!.bytes), Array.from(content));
    assert.deepEqual(world.manifest.get("data/note.txt"), {
      kind: "file",
      sha: sha(content),
      size: content.byteLength,
      mode: facts.mode & 0o777,
    });

    const second = await world.transfer.syncFile("store-1", world.manifest, "data/note.txt", filePath, facts);
    assert.equal(second, "unchanged");
    assert.equal(world.smallWrites.length, 1);
  });
});

test("bypassing the stat cache hashes bytes before adopting an existing manifest entry", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "note.txt");
    const before = Buffer.from("older");
    const after = Buffer.from("newer");
    writeFileSync(filePath, after);
    const world = transferWorld(root);
    const facts = fileFacts(filePath);
    const mode = facts.mode & 0o777;
    world.manifest.set("data/note.txt", { kind: "file", sha: sha(before), size: before.length, mode });
    world.transfer.localStat.set("data/note.txt", { mtimeMs: facts.mtimeMs, size: facts.size, sha: sha(before), mode });

    const outcome = await world.transfer.syncFile("store-1", world.manifest, "data/note.txt", filePath, facts, true);
    assert.equal(outcome, "uploaded");
    assert.equal(world.smallWrites[0]?.key, `blobs/${sha(after)}`);
    assert.deepEqual(world.manifest.get("data/note.txt"), { kind: "file", sha: sha(after), size: after.length, mode });
  });
});

test("large-file sync streams through a temporary copy and removes that copy", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "large.bin");
    const content = Buffer.from("large-object");
    writeFileSync(filePath, content);
    const world = transferWorld(root, { largeObjectThreshold: 4 });

    const outcome = await world.transfer.syncFile("store-1", world.manifest, "data/large.bin", filePath, fileFacts(filePath));
    assert.equal(outcome, "uploaded");
    assert.equal(world.smallWrites.length, 0);
    assert.equal(world.fileWrites.length, 1);
    assert.equal(world.fileWrites[0]?.key, `blobs/${sha(content)}`);
    assert.equal(world.fileWrites[0]?.path.includes(".box-store-snap-"), true);
    assert.deepEqual(Array.from(world.fileWrites[0]!.bytes), Array.from(content));
    assert.equal(existsSync(world.fileWrites[0]!.path), false);
  });
});

test("a large file with unchanged content adopts a mode-only change without copying", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "large.bin");
    const content = Buffer.from("large-object");
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o600);
    const facts = fileFacts(filePath);
    const mode = facts.mode & 0o777;
    const world = transferWorld(root, { largeObjectThreshold: 4 });
    world.manifest.set("data/large.bin", { kind: "file", sha: sha(content), size: content.length, mode: 0o644 });

    const outcome = await world.transfer.syncFile("store-1", world.manifest, "data/large.bin", filePath, facts);
    assert.equal(outcome, "unchanged");
    assert.equal(world.smallWrites.length, 0);
    assert.equal(world.fileWrites.length, 0);
    assert.deepEqual(world.manifest.get("data/large.bin"), { kind: "file", sha: sha(content), size: content.length, mode });
  });
});

test("a large copy waits for disk space before making a temporary object", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "large.bin");
    writeFileSync(filePath, "large-object");
    const world = transferWorld(root, { largeObjectThreshold: 4, freeDiskBytes: 0 });

    const outcome = await world.transfer.syncFile("store-1", world.manifest, "data/large.bin", filePath, fileFacts(filePath));
    assert.equal(outcome, "error");
    assert.equal(world.smallWrites.length, 0);
    assert.equal(world.fileWrites.length, 0);
    assert.deepEqual(readdirSync(root), ["large.bin"]);
  });
});

test("oversize data becomes metadata failure when the existing path changed identity", async () => {
  await withTempDir(async (root) => {
    const filePath = join(root, "too-big.txt");
    writeFileSync(filePath, "larger than cap");
    const world = transferWorld(root, { maxObjectBytes: 4 });
    const facts = fileFacts(filePath);
    world.manifest.set("data/too-big.txt", {
      kind: "file",
      sha: "previous",
      size: 3,
      mode: 0o600,
    });

    const outcome = await world.transfer.syncFile("store-1", world.manifest, "data/too-big.txt", filePath, facts);
    assert.equal(outcome, "metadata-error");
    assert.equal(world.smallWrites.length, 0);
    assert.equal(world.fileWrites.length, 0);
  });
});

test("a category records symlinks as metadata and prunes stale paths only after a complete walk", async () => {
  await withTempDir(async (root) => {
    const categoryRoot = join(root, "data");
    mkdirSync(categoryRoot);
    symlinkSync("missing-target", join(categoryRoot, "link"));
    const world = transferWorld(root);
    world.manifest.set("data/stale.txt", { kind: "file", sha: "old", size: 1, mode: 0o644 });
    const category: BoxStoreTransferCategory = { name: "data", absRoot: categoryRoot, relPrefix: "data" };

    const summary = await world.transfer.syncCategory("store-1", category);
    assert.equal(summary.filesScanned, 1);
    assert.equal(summary.filesUploaded, 1);
    assert.equal(summary.bytesUploaded, 0);
    assert.equal(summary.removed, 1);
    assert.deepEqual(world.manifest.get("data/link"), { kind: "symlink", target: "missing-target" });
    assert.equal(world.manifest.has("data/stale.txt"), false);
    assert.equal(world.smallWrites.length, 0);
  });

  await withTempDir(async (root) => {
    const unreadableRoot = join(root, "not-a-directory");
    writeFileSync(unreadableRoot, "content");
    const world = transferWorld(root);
    world.manifest.set("data/keep.txt", { kind: "file", sha: "old", size: 1, mode: 0o644 });
    const category: BoxStoreTransferCategory = { name: "data", absRoot: unreadableRoot, relPrefix: "data" };

    const summary = await world.transfer.syncCategory("store-1", category);
    assert.equal(summary.failures, 1);
    assert.equal(summary.metadataFailures, 1);
    assert.equal(summary.removed, 0);
    assert.equal(world.manifest.has("data/keep.txt"), true);
  });
});

test("a staged-only category uses the staged mode and cleans up after upload", async () => {
  await withTempDir(async (root) => {
    const stagedPath = join(root, "staged.txt");
    writeFileSync(stagedPath, "from stage");
    const world = transferWorld(root);
    let cleanupCalls = 0;
    const category: BoxStoreTransferCategory = {
      name: "staged",
      absRoot: join(root, "not-mounted"),
      relPrefix: "staged",
      stageOnly: true,
      async stage() {
        return {
          files: [{ absPath: stagedPath, relPath: "staged/current.txt", mode: 0o600 }],
          skipped: 1,
          async cleanup() { cleanupCalls += 1 },
        };
      },
    };

    const summary = await world.transfer.syncCategory("store-1", category);
    assert.equal(summary.filesUploaded, 1);
    assert.equal(summary.failures, 1, "a staged component the builder skipped remains visible in the category summary");
    assert.equal(cleanupCalls, 1);
    const stagedEntry = world.manifest.get("staged/current.txt");
    assert.equal(stagedEntry?.kind, "file");
    if (stagedEntry?.kind === "file") assert.equal(stagedEntry.mode, 0o600);
  });
});
