import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { StoreDbBundleCapture, createStoreDbCaptureTrace, recordStoreDbCaptureFailure } from "../../source/host/boxes/box-store-sync/store-db-bundle-capture.ts";

const fileEntry = (sha: string, size: number, mode = 0o644) => ({ sha, size, mode });
function harness(seed: any = {}) {
  const manifest = new Map<string, any>(seed.manifest ?? []);
  const uncommitted = new Map<string, any>();
  const signatures = new Map<string, any>(seed.signatures ?? []);
  const uploads: any[] = [];
  const logs: string[] = [];
  const capture = new StoreDbBundleCapture({
    now: () => 1_000,
    log: (message) => logs.push(message),
    manifestStore: { isLiveManifest: () => seed.liveManifest ?? true, uncommittedStoreDbEntries: uncommitted, setManifestEntry: (map: any, relPath: string, entry: any) => { const previous = map.get(relPath); map.set(relPath, entry); return JSON.stringify(previous) !== JSON.stringify(entry); } } as never,
    transfer: { hasDiskSpaceForLargeObject: async () => seed.hasDiskSpace ?? true } as never,
    largeObjectThreshold: seed.largeObjectThreshold ?? 1_000_000,
    snapshotUpload: {
      runVacuumOffThread: async (args: any) => { writeFileSync(args.destPath, "vacuumed"); if (seed.touchDuringVacuum) { const target = args.srcPath as string; writeFileSync(target + ".swap", "moved"); renameSync(target + ".swap", target); } },
      uploadAgentDbSnapshot: async (storeId: string, map: any, relPath: string, tmpPath: string, mode: number) => {
        uploads.push({ storeId, relPath, mode, tmpPath: tmpPath.split(tmpdir()).join("<tmp>") });
        if (seed.uploadThrows) throw new Error("upload failed");
        map.set(relPath, fileEntry("sha-" + relPath, 9, mode));
        return { outcome: seed.outcome ?? "uploaded", bytesUploaded: seed.bytesUploaded ?? 9, blobUploadDurationMs: 5 };
      },
      discardSnapshotTemp: async () => undefined,
    } as never,
    ...(seed.writeGeneration ? { getWriteGeneration: seed.writeGeneration } : {}),
    storeDbCaptures: signatures,
  });
  return { capture, manifest, uncommitted, signatures, uploads, logs };
}
const basePath = (basename: string) => "project/agents/agent-1/" + basename;
function agentDir(files: Record<string, string> = { "store.db": "database" }): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-capture-test-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const summary = () => ({ filesScanned: 0, filesUploaded: 0, filesUnchanged: 0, filesFailed: 0, bytesUploaded: 0, failures: 0 }) as any;
const coordTarget = (dir: string, name: string) => ({ relPath: "project/agents/agent-1/" + name, absPath: join(dir, name), effectiveSize: 1 });

describe("capturing an agent's databases", () => {
  it("describes what the files look like, and refuses a pending recovery", async () => {
    const dir = agentDir({});
    try {
      const { capture, manifest } = harness();
      const targets = [{ relPath: basePath("store.db"), absPath: join(dir, "store.db"), effectiveSize: 1 }];
      assert.equal(await capture.agentDbBundleIdentity({ agentDir: dir, relPrefix: "project", agentId: "agent-1", targets, manifest: manifest as never }), null, "a target that is not there cannot be trusted");
      assert.equal(await capture.agentHasPendingDbRecovery(dir), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const pendingDir = agentDir({ "conversation-blobs.db.pending": "x" });
    try {
      const { capture, manifest } = harness();
      const targets = [{ relPath: basePath("conversation-blobs.db"), absPath: join(pendingDir, "store.db"), effectiveSize: 1 }];
      assert.equal(await capture.agentDbBundleIdentity({ agentDir: pendingDir, relPrefix: "project", agentId: "agent-1", targets, manifest: manifest as never }), null);
      assert.equal(await capture.agentHasPendingDbRecovery(pendingDir), true);
      const blockedDir = agentDir({ "store.db": "database", "conversation-blobs.db.pending": "x" });
      try {
        const matching = coordTarget(blockedDir, "store.db");
        assert.equal(await capture.agentDbBundleIdentity({ agentDir: blockedDir, relPrefix: "project", agentId: "agent-1", targets: [matching], manifest: manifest as never }), null, "a pending recovery blocks a matching database");
      } finally { rmSync(blockedDir, { recursive: true, force: true }); }
    } finally { rmSync(pendingDir, { recursive: true, force: true }); }
  });

  it("captures a database through the lease manifest", async () => {
    const dir = agentDir();
    try {
      const { capture, manifest, uploads, signatures, uncommitted } = harness();
      const targets = [{ relPath: basePath("store.db"), absPath: join(dir, "store.db"), effectiveSize: 10 }];
      const scan = summary();
      const trace = createStoreDbCaptureTrace();
      const result = await capture.captureAgentDbBundle({ agentId: "agent-1", agentDir: dir, relPrefix: "project", storeId: "store-1", manifest: manifest as never, targets, summary: scan, captureTrace: trace });
      assert.equal(result, true);
      assert.deepEqual(uploads.map((upload) => upload.storeId), ["store-1"]);
      assert.equal(manifest.has(basePath("store.db")), true);
      assert.equal(signatures.has(basePath("store.db")), true);
      assert.notEqual(uncommitted.get(basePath("store.db")), undefined, "the new entry is remembered as uncommitted until the manifest lands");
      assert.equal(scan.filesScanned, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("answers false when an upload fails and records the phase", async () => {
    const dir = agentDir();
    try {
      const { capture, manifest, logs } = harness({ uploadThrows: true });
      const targets = [{ relPath: basePath("store.db"), absPath: join(dir, "store.db"), effectiveSize: 10 }];
      const trace = createStoreDbCaptureTrace();
      const result = await capture.captureAgentDbBundle({ agentId: "agent-1", agentDir: dir, relPrefix: "project", storeId: "store-1", manifest: manifest as never, targets, summary: summary(), captureTrace: trace });
      assert.equal(result, false);
      assert.equal(manifest.has(basePath("store.db")), false, "nothing is committed when the upload failed");
      assert.equal(trace.failurePhase, "capture");
      assert.equal(logs.length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("defers a large database when there is no disk space", async () => {
    const dir = agentDir();
    try {
      const { capture, manifest, uploads, logs } = harness({ hasDiskSpace: false, largeObjectThreshold: 1 });
      const targets = [{ relPath: basePath("store.db"), absPath: join(dir, "store.db"), effectiveSize: 10 }];
      const result = await capture.captureAgentDbBundle({ agentId: "agent-1", agentDir: dir, relPrefix: "project", storeId: "store-1", manifest: manifest as never, targets, summary: summary(), captureTrace: createStoreDbCaptureTrace() });
      assert.equal(result, false);
      assert.deepEqual(uploads, []);
      assert.match(logs[0] ?? "", /insufficient disk space/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("skips a database that is already durable and stays durable", async () => {
    const dir = agentDir();
    try {
      const stats = statSync(join(dir, "store.db"));
      const relPath = basePath("store.db");
      const { capture, manifest, uploads } = harness({
        manifest: [[relPath, fileEntry("sha-db", stats.size, stats.mode & 0o777)]],
        signatures: [[relPath, { writeGeneration: 0, mtimeMs: stats.mtimeMs, size: stats.size, sha: "sha-db", mode: stats.mode & 0o777, walSize: 0, walMtimeMs: 0 }]],
        writeGeneration: () => 0,
      });
      assert.equal(await capture.isAgentDbDurablyCaptured(relPath, join(dir, "store.db"), stats, manifest as never), true);
      assert.equal(await capture.isAgentDbDurablyCaptured(relPath, join(dir, "store.db"), { ...stats, mtimeMs: stats.mtimeMs + 5 } as never, manifest as never), false, "a newer mtime is not durable");
      const otherGeneration = harness({ manifest: [[relPath, fileEntry("sha-db", stats.size, stats.mode & 0o777)]], signatures: [[relPath, { writeGeneration: 0, mtimeMs: stats.mtimeMs, size: stats.size, sha: "sha-db", mode: stats.mode & 0o777, walSize: 0, walMtimeMs: 0 }]], writeGeneration: () => 7 });
      assert.equal(await otherGeneration.capture.isAgentDbDurablyCaptured(relPath, join(dir, "store.db"), stats, otherGeneration.manifest as never), false, "a new write generation is not durable");
      const targets = [{ relPath, absPath: join(dir, "store.db"), effectiveSize: 10 }];
      assert.equal(capture.isAgentDbBundleCommitted(manifest as never, targets), true);
      const uncommittedHarness = harness({ manifest: [[relPath, fileEntry("sha-db", stats.size, stats.mode & 0o777)]] });
      uncommittedHarness.uncommitted.set(relPath, fileEntry("sha-db", stats.size, stats.mode & 0o777));
      assert.equal(uncommittedHarness.capture.isAgentDbBundleCommitted(uncommittedHarness.manifest as never, targets), false, "an uncommitted entry means the bundle is not committed yet");
      const { uncommitted: uncommittedEntries } = harness();
      void uncommittedEntries;

      assert.equal(await capture.captureAgentDbBundle({ agentId: "agent-1", agentDir: dir, relPrefix: "project", storeId: "store-1", manifest: manifest as never, targets, summary: summary(), captureTrace: createStoreDbCaptureTrace() }), true);
      assert.deepEqual(uploads, [], "a durable database is not vacuumed again");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not commit a bundle whose files moved during the snapshot", async () => {
    const dir = agentDir();
    try {
      const { capture, manifest } = harness({ touchDuringVacuum: true });
      const targets = [coordTarget(dir, "store.db")];
      const result = await capture.captureAgentDbBundle({ agentId: "agent-1", agentDir: dir, relPrefix: "project", storeId: "store-1", manifest: manifest as never, targets, summary: summary(), captureTrace: createStoreDbCaptureTrace() });
      assert.equal(result, false);
      assert.equal(manifest.has(basePath("store.db")), false, "nothing is committed when the files moved");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads the write-ahead log and compares frames", async () => {
    const dir = agentDir();
    try {
      const { capture } = harness();
      assert.deepEqual(await capture.readWalStat(join(dir, "store.db")), { size: 0, mtimeMs: 0 });
      writeFileSync(join(dir, "store.db-wal"), "frames");
      const present = await capture.readWalStat(join(dir, "store.db"));
      assert.equal(present?.size, 6);
      assert.equal(await capture.walHasNoNewFramesSince(join(dir, "store.db"), { size: 0, mtimeMs: 0 }), false);
      assert.equal(await capture.walHasNoNewFramesSince(join(dir, "store.db"), present!), true);
      assert.equal(await capture.walHasNoNewFramesSince(join(dir, "store.db"), { size: -1, mtimeMs: -1 }), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("remembers the latest failure phase", () => {
    const trace = createStoreDbCaptureTrace();
    recordStoreDbCaptureFailure(trace, "manifest_commit");
    recordStoreDbCaptureFailure(trace, "capture");
    assert.equal(trace.failurePhase, "manifest_commit", "a later phase outranks an earlier one");
    recordStoreDbCaptureFailure(trace, "blob_upload");
    assert.equal(trace.failurePhase, "manifest_commit");
    const second = createStoreDbCaptureTrace();
    recordStoreDbCaptureFailure(second, "capture");
    recordStoreDbCaptureFailure(second, "blob_upload");
    assert.equal(second.failurePhase, "blob_upload");
  });
});