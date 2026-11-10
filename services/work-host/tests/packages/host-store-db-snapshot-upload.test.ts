/**
 * One database snapshot on its way into the store: the stat, the hash, the manifest comparison, the upload, the vacuum
 * worker fallback and temporary-file cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreDbSnapshotUpload } from "../../source/host/boxes/box-store-sync/store-db-snapshot-upload.ts";
import { BOX_STORE_BLOBS_PREFIX } from "../../source/host/boxes/box-store-sync/box-store-manifest-format.ts";

function harness(options: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const puts: unknown[] = [];
  const putFromFiles: unknown[] = [];
  const manifestEntries: Array<{ relPath: string; entry: unknown }> = [];
  const stores: string[] = [];
  const objectStore = {
    async put(path: string, bytes: Uint8Array, settings: unknown) {
      puts.push({ path, length: bytes.length, settings });
      if (options.putThrows === true) throw new Error("the store refused the blob");
      return path;
    },
    async putFromFile(path: string, filePath: string, sha: string, size: number) {
      putFromFiles.push({ path, filePath, sha, size });
      if (options.putFromFileThrows === true) throw new Error("the store refused the stream");
      return path;
    },
  };
  const upload = new StoreDbSnapshotUpload({
    objectStoreProvider: { forStore: (storeId: string) => { stores.push(storeId); return objectStore; } } as never,
    now: () => (options.nowValue as number | undefined) ?? 1000,
    log: (message: string) => logs.push(message),
    manifestStore: { setManifestEntry: (manifest: unknown, relPath: string, entry: unknown) => { manifestEntries.push({ relPath, entry }); (manifest as Map<string, unknown>).set(relPath, entry); } } as never,
    maxObjectBytes: (options.maxObjectBytes as number | undefined) ?? 1024,
    largeObjectThreshold: (options.largeObjectThreshold as number | undefined) ?? 10,
  });
  const manifest = (options.manifest as Map<string, unknown> | undefined) ?? new Map<string, unknown>();
  return { upload, manifest, logs, puts, putFromFiles, manifestEntries, stores };
}

test("a small snapshot is hashed in memory, uploaded and recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  const bytes = Buffer.from("a small database");
  await writeFile(file, bytes);
  const world = harness({ maxObjectBytes: 1024, largeObjectThreshold: 100 });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", file, 0o644);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(result, { outcome: "uploaded", bytesUploaded: bytes.length, blobUploadDurationMs: 0 });
  assert.deepEqual(world.puts, [{ path: BOX_STORE_BLOBS_PREFIX + "/" + sha, length: bytes.length, settings: { contentAddressed: true } }]);
  assert.equal(world.putFromFiles.length, 0);
  assert.deepEqual(world.manifestEntries, [{ relPath: "data/agent.db", entry: { kind: "file", sha, size: bytes.length, mode: 0o644 } }]);
  assert.equal(world.stores[0], "store-1");
});

test("a snapshot equal to the manifest is not uploaded again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  const bytes = Buffer.from("same");
  await writeFile(file, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const manifest = new Map<string, unknown>([["data/agent.db", { kind: "file", sha, size: bytes.length }]]);
  const world = harness({ manifest });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", manifest as never, "data/agent.db", file, 0o644);
  assert.deepEqual(result, { outcome: "unchanged", bytesUploaded: 0, blobUploadDurationMs: 0 });
  assert.equal(world.puts.length, 0);
  assert.equal(world.putFromFiles.length, 0);
  assert.equal(world.manifestEntries.length, 1);
});

test("a snapshot larger than the store allows is refused before it is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  await writeFile(file, Buffer.alloc(4));
  const world = harness({ maxObjectBytes: 2 });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", file, 0o644);
  assert.deepEqual(result, { outcome: "oversize", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" });
  assert.equal(world.logs[0], "oversize data/agent.db: 4B over 2B");
});

test("a large snapshot is streamed from disk rather than read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  const bytes = Buffer.from("a large snapshot body");
  await writeFile(file, bytes);
  const world = harness({ largeObjectThreshold: 4 });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", file, 0o600);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(result, { outcome: "uploaded", bytesUploaded: bytes.length, blobUploadDurationMs: 0 });
  assert.deepEqual(world.putFromFiles, [{ path: BOX_STORE_BLOBS_PREFIX + "/" + sha, filePath: file, sha, size: bytes.length }]);
  assert.equal(world.puts.length, 0);
});

test("a missing snapshot file is a capture failure with a log line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const world = harness({});
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", join(dir, "missing.db"), 0o644);
  assert.deepEqual(result, { outcome: "error", bytesUploaded: 0, blobUploadDurationMs: 0, failurePhase: "capture" });
  assert.match(world.logs[0] ?? "", /^store\.db data\/agent\.db snapshot stat failed: /);
});

test("a read failure is a capture failure with a log line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const world = harness({});
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", dir, 0o644);
  assert.equal(result.outcome, "error");
  assert.match(world.logs[0] ?? "", /^read failed data\/agent\.db: /);
});

test("an upload failure is a blob failure carrying the time it spent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  await writeFile(file, Buffer.from("data"));
  const world = harness({ putThrows: true, nowValue: 1500, largeObjectThreshold: 100 });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", file, 0o644);
  assert.equal(result.outcome, "error");
  assert.equal(result.failurePhase, "blob_upload");
  assert.equal("bytesUploaded" in result && result.bytesUploaded, 0);
  assert.match(world.logs[0] ?? "", /^upload failed data\/agent\.db: the store refused the blob$/);
  assert.equal(world.manifestEntries.length, 0);
});

test("the elapsed duration never goes negative", () => {
  const world = harness({ nowValue: 900 });
  assert.equal(world.upload.elapsedDurationMs(1000), 0);
  assert.equal(world.upload.objectStore("store-1") !== undefined, true);
});

test("temporary files are removed, and a missing one is not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const world = harness({});
  const file = join(dir, "temp.db");
  await writeFile(file, Buffer.from("x"));
  await world.upload.discardSnapshotTemp({ tmpPath: file, label: "cleanup" });
  await assert.rejects(() => readFile(file));
  await world.upload.discardSnapshotTemp({ tmpPath: join(dir, "already-gone.db"), label: "cleanup" });
  assert.deepEqual(world.logs, []);
  await mkdir(join(dir, "a-directory"));
  await world.upload.discardSnapshotTemp({ tmpPath: join(dir, "a-directory"), label: "cleanup" });
  assert.match(world.logs[0] ?? "", /^temp cleanup failed cleanup: /);
});

test("with no worker bundle the vacuum runs in process after clearing the destination", async () => {
  const world = harness({});
  await assert.rejects(() => world.upload.runVacuumOffThread({ srcPath: "/nonexistent-source.db", destPath: join(tmpdir(), "nonexistent-dest.db") }));
  assert.equal(world.logs.length, 1);
  assert.match(world.logs[0] ?? "", /^vacuum worker bundle absent \(.*\); using in-process VACUUM$/);
});

test("a snapshot exactly at the size limit is allowed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "snapshot-upload-"));
  const file = join(dir, "snap.db");
  await writeFile(file, Buffer.alloc(4));
  const world = harness({ maxObjectBytes: 4, largeObjectThreshold: 100 });
  const result = await world.upload.uploadAgentDbSnapshot("store-1", world.manifest as never, "data/agent.db", file, 0o644);
  assert.equal(result.outcome, "uploaded");
});
