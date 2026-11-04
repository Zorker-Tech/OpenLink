/**
 * The box store's smaller decisions: what a path is allowed to be, what a manifest may hold, when a cycle can say it is
 * complete, and what a copy-in tells the platform when it does not finish.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, lstatSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { BoxStoreDownload, copyFileHashing, makeInFlightByteBudget, resolveRestoreDestination, sha256File, symlinkTargetStaysWithinRoot } from "../../source/host/boxes/box-store-sync/box-store-download.ts";
import { dedupeNestedRoots, globToRegExp, walkNodes } from "../../source/host/boxes/box-store-sync/box-store-transfer.ts";
import { hasManifestPathConflict, parseManifest, BoxStoreUnsupportedManifestVersionError, BoxStoreManifestPathConflictError, BoxStoreManifestRevisionState, countStoreDbManifestEntries, getStoreDbManifestAgentIds, countAgentDirManifestEntries } from "../../source/host/boxes/box-store-sync/box-store-manifest.ts";
import { evaluateBoxStoreFlush, boxStoreSyncCycleTelemetry, type BoxStoreCycleSummary } from "../../source/host/boxes/box-store-sync/box-store-sync.ts";
import { aggregateStoreDbSweepOutcome, boxStoreDbCaptureTelemetry, StoreDbCapture } from "../../source/host/boxes/box-store-sync/store-db-capture.ts";
import { isCriticalRelPath } from "../../source/host/boxes/box-store-sync/box-store-download.ts";
import {
  bucketCopyInReason,
  buildCopyInStatusFromResult,
  buildCopyInWatchdogEvent,
  classifyCopyInFailure,
  classifyCopyInMeteredOutcome,
  isTransientCopyInFailure,
  makeCopyInStatusWriter,
  outcomeToExitCode,
  redactCopyInErrorForTelemetry,
  resolveCopyInAttempts,
  resolveCopyInConcurrency,
  resolveCopyInStuckThresholdMs,
  BOX_COPY_IN_EXIT_FAILED,
  BOX_COPY_IN_EXIT_HYDRATED,
  BOX_COPY_IN_EXIT_NOOP,
  COPY_IN_HYDRATE_ATTEMPTS,
  COPY_IN_STUCK_THRESHOLD_MS,
} from "../../source/host/boxes/box-store-sync/copy-in-reporting.ts";
import { empty } from "../../source/host/boxes/box-store-sync/box-copy-in.ts";
import type { CopyInResult } from "../../source/host/boxes/box-store-sync/copy-in-contracts.ts";



const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("what a restore may write", () => {
  it("refuses every shape of unsafe path and accepts ordinary ones", () => {
    const root = "/tmp/restore-root";
    assert.equal(resolveRestoreDestination({ targetRoot: root, relPath: "home/box/a.txt" }), "/tmp/restore-root/home/box/a.txt");
    for (const relPath of ["", "/etc/passwd", "a//b", "a/./b", "a/../b", "..", "."]) {
      assert.equal(resolveRestoreDestination({ targetRoot: root, relPath }), undefined, relPath);
    }
  });

  it("keeps a symlink inside the root, whether its target is relative or absolute", () => {
    const args = { targetRoot: "/tmp/restore-root", destPath: "/tmp/restore-root/home/box/link", target: "../box/target" };
    assert.equal(symlinkTargetStaysWithinRoot(args), true);
    assert.equal(symlinkTargetStaysWithinRoot({ ...args, target: "/etc/passwd" }), false);
    assert.equal(symlinkTargetStaysWithinRoot({ ...args, target: "../../../../etc/passwd" }), false);
  });

  it("names the files a box needs first", () => {
    assert.equal(isCriticalRelPath("home/box/slate-data/agents/a/store.db"), true);
    assert.equal(isCriticalRelPath("home/box/chrome-profile/Default/Cookies"), true);
    assert.equal(isCriticalRelPath("home/box/workspace/notes.txt"), false);
  });
});

describe("moving bytes", () => {
  it("admits within the budget, and admits one oversized blob rather than deadlocking", async () => {
    const budget = makeInFlightByteBudget(10);
    await budget.acquire(10);
    let admitted = false;
    const waiting = budget.acquire(1).then(() => {
      admitted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(admitted, false);
    budget.release(10);
    await waiting;
    assert.equal(admitted, true);
    budget.release(1);
    // A blob larger than the whole budget goes through when nothing else is in flight.
    await makeInFlightByteBudget(1).acquire(99);
  });

  it("hashes a file and copies it while hashing, refusing a link", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-hash-"));
    try {
      const source = join(directory, "a.txt");
      writeFileSync(source, "hello", "utf8");
      assert.equal(await sha256File(source), sha("hello"));
      const copied = await copyFileHashing(source, join(directory, "b.txt"));
      assert.deepEqual([copied.sha, copied.size], [sha("hello"), 5]);
      assert.equal(readFileSync(join(directory, "b.txt"), "utf8"), "hello");
      symlinkSync(source, join(directory, "link.txt"));
      // The open refuses the link itself (ELOOP) rather than following it to the file it names.
      await assert.rejects(() => sha256File(join(directory, "link.txt")), /ELOOP/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("walks a tree without following links, and reports a directory it cannot read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-walk-"));
    try {
      mkdirSync(join(directory, "nested"));
      writeFileSync(join(directory, "nested", "a.txt"), "a", "utf8");
      symlinkSync(join(directory, "nested"), join(directory, "link"));
      const found: string[] = [];
      for await (const node of walkNodes(directory)) found.push(node.kind === "readdir-error" ? "error" : `${node.kind}:${node.absPath.slice(directory.length + 1)}`);
      assert.deepEqual(found.sort(), ["file:nested/a.txt", "symlink:link"]);
      // A skip predicate prunes a directory, and the walk never descends into it.
      const pruned: string[] = [];
      for await (const node of walkNodes(directory, (relDir) => relDir === "nested")) pruned.push(node.kind === "readdir-error" ? "error" : node.kind);
      assert.deepEqual(pruned, ["symlink"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("turns a glob into a path-aware regular expression, and dedupes nested roots", () => {
    const exclude = globToRegExp("home/box/slate-data/**/*.corrupt-*");
    assert.equal(exclude.test("home/box/slate-data/agents/a/store.db.corrupt-1"), true);
    assert.equal(exclude.test("home/box/other/store.db.corrupt-1"), false);
    // A single star does not cross a directory: a rule for files directly under one directory is not a rule for the tree.
    const direct = globToRegExp("home/box/slate-data/*.txt");
    assert.equal(direct.test("home/box/slate-data/a.txt"), true);
    assert.equal(direct.test("home/box/slate-data/nested/a.txt"), false);
    assert.deepEqual(dedupeNestedRoots(["/a", "/a/b", "/a/c", "/d"]), ["/a", "/d"]);
  });
});

describe("the manifest", () => {
  const manifestOf = (entries: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify({ version: 2, updatedAtMs: 1, writerWindowId: "w", entries }));

  it("refuses a version it does not know, and a set of paths that cannot coexist", () => {
    assert.throws(() => parseManifest(new TextEncoder().encode(JSON.stringify({ version: 9, entries: {} }))), (error: unknown) => error instanceof BoxStoreUnsupportedManifestVersionError);
    const conflict = { version: 2, updatedAtMs: 1, entries: { "a": { kind: "file", sha: sha("x"), size: 1, mode: 0o644 }, "a/b": { kind: "file", sha: sha("y"), size: 1, mode: 0o644 } } };
    assert.throws(() => parseManifest(new TextEncoder().encode(JSON.stringify(conflict))), (error: unknown) => error instanceof BoxStoreManifestPathConflictError);
    assert.equal(hasManifestPathConflict({ "a": {}, "a/b": {} }), true);
    assert.equal(hasManifestPathConflict({ "a/b": {}, "a/c": {} }), false);
    // Not JSON at all is not an error, it is an empty answer.
    assert.equal(parseManifest(new TextEncoder().encode("not json")), null);
  });

  it("counts what the store holds: store databases, agents, and every path under an agent", () => {
    const manifest = new Map<string, unknown>([
      ["home/box/slate-data/agents/a/store.db", { kind: "file", sha: sha("a"), size: 1, mode: 0o644 }],
      ["home/box/slate-data/agents/a/conversation-blobs.db", { kind: "file", sha: sha("b"), size: 1, mode: 0o644 }],
      ["home/box/slate-data/agents/a/notes.bin", { kind: "file", sha: sha("c"), size: 1, mode: 0o644 }],
      ["home/box/slate-data/agents/b/store.db", { kind: "symlink", target: "elsewhere" }],
      ["home/box/slate-data/other.txt", { kind: "file", sha: sha("d"), size: 1, mode: 0o644 }],
    ]);
    assert.equal(countStoreDbManifestEntries(manifest), 1);
    assert.deepEqual([...getStoreDbManifestAgentIds(manifest)], ["a"]);
    assert.equal(countAgentDirManifestEntries(manifest), 2);
  });

  it("writes a revision only when it would say something new, and forgets what the store holds after a failure", () => {
    const state = new BoxStoreManifestRevisionState();
    const manifest = new Map([["a", { kind: "file" as const, sha: sha("a"), size: 1, mode: 0o644 }]]);
    // Nothing is known to be persisted yet, so the first write is a real one.
    const first = state.capture(manifest, undefined, false);
    assert.notEqual(first, null);
    // While that write is in flight, another one for the same revision is not worth making.
    assert.equal(state.capture(manifest, undefined, false), null);
    state.markPersisted(first!, undefined);
    assert.equal(state.capture(manifest, undefined, false), null);
    state.release(first!);
    // Once the store has this revision, there is nothing to write.
    assert.equal(state.capture(manifest, undefined, false), null);
    // A change makes a new revision, which is worth a write — and a required write is made even when nothing changed.
    state.markChanged();
    const second = state.capture(manifest, undefined, false);
    assert.notEqual(second, null);
    const required = state.capture(manifest, undefined, true);
    assert.notEqual(required, null);
    state.release(second!);
    state.release(required!);
    // A write that lands is what the store is believed to hold — until a failure says otherwise, and then the next write
    // is a real one again.
    state.markPersisted(second!, undefined);
    assert.equal(state.capture(manifest, undefined, false), null);
    state.markFailed();
    assert.notEqual(state.capture(manifest, undefined, false), null);
  });
});

describe("what a cycle and a capture report", () => {
  const cycle = (overrides: Partial<BoxStoreCycleSummary> = {}): BoxStoreCycleSummary => ({
    ok: true,
    storeId: "store-1",
    durationMs: 5,
    categories: [{ name: "slate-data", filesScanned: 2, filesUploaded: 1, bytesUploaded: 10, skippedUnchanged: 1, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 }],
    manifestEntries: 2,
    storeDbEntries: 1,
    storeDbComplete: true,
    agentDirEntries: 1,
    totalFilesUploaded: 1,
    totalBytesUploaded: 10,
    totalFailures: 0,
    metadataFailures: 0,
    ...overrides,
  });

  it("reports a cycle, stays quiet about an in-flight one, and warns about the rest", () => {
    assert.equal(boxStoreSyncCycleTelemetry(cycle())?.level, "info");
    assert.equal(boxStoreSyncCycleTelemetry(cycle({ ok: false, reason: "in-flight" })), null);
    assert.equal(boxStoreSyncCycleTelemetry(cycle({ ok: false, reason: "locked" }))?.metadata.reason, "locked");
    assert.equal(boxStoreSyncCycleTelemetry(cycle({ ok: false, reason: "boom" }))?.metadata.reason, "error");
  });

  it("only calls a flush complete when nothing stands in the way", () => {
    const session = { sessionCategoryName: "chrome-session" };
    assert.equal(evaluateBoxStoreFlush(cycle(), session).ok, true);
    const storeDbCategory = { name: "store.db", filesScanned: 1, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 1, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 };
    assert.equal(evaluateBoxStoreFlush(cycle({ storeDbComplete: false, categories: [storeDbCategory] }), session).reason, "store-db-incomplete");
    assert.equal(evaluateBoxStoreFlush(cycle({ metadataFailures: 1 }), session).reason, "filesystem-metadata-incomplete");
    const chromeFailed = cycle({ categories: [{ name: "chrome-session", filesScanned: 1, filesUploaded: 0, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 1, metadataFailures: 0 }] });
    assert.equal(evaluateBoxStoreFlush(chromeFailed, session).reason, "chrome-session-stage-failed");
    assert.equal(evaluateBoxStoreFlush(null, session).reason, "error");
  });

  it("names a capture's outcome from what did and did not happen", () => {
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 1, oversize: 0, filesUploaded: 0, filesScanned: 1 }), "error");
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 1, filesUploaded: 0, filesScanned: 1 }), "oversize");
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 1, filesScanned: 1 }), "uploaded");
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 0, filesScanned: 3 }), "unchanged");
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 0, filesScanned: 0 }), "skipped");
    const telemetry = boxStoreDbCaptureTelemetry({
      outcome: "error",
      trigger: "flush",
      failurePhase: "capture",
      isCommitted: false,
      agentCount: 1,
      filesScanned: 1,
      filesUploaded: 0,
      bytes: 0,
      durationMs: 3,
      queueDurationMs: 0,
      captureDurationMs: 2,
      blobUploadDurationMs: 0,
      manifestCommitDurationMs: 1,
      storeId: "store-1",
    });
    assert.equal(telemetry.level, "warn");
    assert.equal(telemetry.metadata.failure_phase, "capture");
  });
});

describe("capturing agent databases", () => {
  /** A capture over a fresh temp directory, with a scripted bundle capture and manifest store. */
  const withCapture = async (
    options: Record<string, unknown>,
    run: (capture: StoreDbCapture, world: { dir: string; category: string; agents: string; addAgent: (name: string, files?: Record<string, number>) => void; logs: unknown[]; saves: unknown[] }) => Promise<unknown>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "slate-capture-"))
    const category = join(dir, "cat")
    const agents = join(category, "agents")
    mkdirSync(agents, { recursive: true })
    const addAgent = (name: string, files: Record<string, number> = {}) => {
      const agentDir = join(agents, name)
      mkdirSync(agentDir, { recursive: true })
      for (const [fileName, size] of Object.entries(files)) writeFileSync(join(agentDir, fileName), Buffer.alloc(size, 1))
    }
    const logs: unknown[] = []
    const saves: unknown[] = []
    const manifest = new Map((options.manifest as [string, unknown][] | undefined) ?? [])
    const capture = new StoreDbCapture({
      deps: {
        categories: [{ absRoot: category, relPrefix: "cat", containsAgentStoreDbs: true }],
        objectStoreProvider: {} as never,
        async resolveStoreId() { return "store-1" },
        hasLiveHandle: (dbPath: string) => ((options.liveHandles as string[] | undefined) ?? []).some((suffix) => dbPath.endsWith(suffix)),
      },
      now: () => 1,
      log: (message: string) => logs.push(message.replace(dir, "<dir>")),
      manifestStore: {
        async loadManifest() { return manifest },
        async saveManifest(storeId: string, saveOptions: { isForced: boolean }) {
          saves.push({ storeId, isForced: saveOptions.isForced })
          if (options.saveThrows === true) throw new Error("save failed")
        },
        writeQueue: Promise.resolve(),
        uncommittedStoreDbEntries: new Set(options.uncommitted as string[] | undefined),
        deleteManifestEntry(map: Map<string, unknown>, relPath: string) { return map.delete(relPath) },
      } as never,
      transfer: { hasDiskSpaceForLargeObject: () => true, localStat: new Map() } as never,
      maxObjectBytes: 10_000,
      uploadConcurrency: 2,
      largeObjectThreshold: 100,
      async ensureWriterLock() { return options.lock !== false },
      isStopped: () => options.stopped === true,
    })
    ;(capture as unknown as { bundleCapture: unknown }).bundleCapture = {
      async agentHasPendingDbRecovery(agentDir: string) { return options.pendingAgent === agentDir.split("/").pop() },
      async readWalStat(absPath: string) {
        const walPath = absPath + "-wal"
        return existsSync(walPath) ? { size: readFileSync(walPath).length } : null
      },
      async captureAgentDbBundle(args: { agentId: string; agentDir: string; targets: { relPath: string; effectiveSize: number }[]; summary: { filesScanned: number; filesUploaded: number }; manifest: Map<string, unknown> }) {
        logs.push({ capture: args.agentId, targets: args.targets.map((target) => [target.relPath.replace(category, "<cat>"), target.effectiveSize]) })
        if (options.removeAgentOnCapture === args.agentId) rmSync(args.agentDir, { recursive: true, force: true })
        if (options.captureThrows === args.agentId) throw new Error("capture blew up")
        if (options.captureFails === args.agentId || options.committed === false) return false
        args.summary.filesScanned += 1
        args.summary.filesUploaded += 1
        if (options.writeManifest !== false) {
          for (const target of args.targets) args.manifest.set(target.relPath, { size: target.effectiveSize })
        }
        return true
      },
      isAgentDbBundleCommitted() { return options.bundleCommitted !== false },
      async isAgentDbSnapshotDurable(relPath: string) { return options.durable === undefined ? true : (options.durable as (path: string) => boolean)(relPath) },
    }
    try {
      const result = await run(capture, { dir, category, agents, addAgent, logs, saves })
      return { result, logs, saves, manifest: [...manifest.keys()] }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("reports what a capture did in the one word the cycle reads", () => {
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 1, oversize: 0, filesUploaded: 0, filesScanned: 0 }), "error")
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 1, filesUploaded: 1, filesScanned: 1 }), "oversize")
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 2, filesScanned: 2 }), "uploaded")
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 0, filesScanned: 2 }), "unchanged")
    assert.equal(aggregateStoreDbSweepOutcome({ failures: 0, oversize: 0, filesUploaded: 0, filesScanned: 0 }), "skipped")
    const telemetry = boxStoreDbCaptureTelemetry({ outcome: "error", trigger: "sweep", failurePhase: "capture", isCommitted: false, agentCount: 2, filesScanned: 3, filesUploaded: 1, bytes: 42, durationMs: 5, queueDurationMs: 1, captureDurationMs: 2, blobUploadDurationMs: 3, manifestCommitDurationMs: 4, storeId: null })
    assert.equal(telemetry.level, "warn")
    assert.deepEqual(telemetry.metadata, { outcome: "error", trigger: "sweep", failure_phase: "capture", committed: "false", agent_count: "2", files_scanned: "3", files_uploaded: "1", bytes: "42", duration_ms: "5", queue_duration_ms: "1", capture_duration_ms: "2", blob_upload_duration_ms: "3", manifest_commit_duration_ms: "4", store_id: undefined })
  })

  it("treats a box with no agents directory as an empty, complete sweep", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slate-capture-empty-"))
    try {
      const manifest = new Map()
      const capture = new StoreDbCapture({
        deps: { categories: [{ absRoot: join(dir, "cat"), relPrefix: "cat", containsAgentStoreDbs: true }], objectStoreProvider: {} as never, async resolveStoreId() { return "s" }, hasLiveHandle: () => false },
        now: () => 1,
        log: () => {},
        manifestStore: { async loadManifest() { return manifest }, async saveManifest() {}, writeQueue: Promise.resolve(), uncommittedStoreDbEntries: new Set(), deleteManifestEntry() { return false } } as never,
        transfer: { hasDiskSpaceForLargeObject: () => true, localStat: new Map() } as never,
        maxObjectBytes: 10,
        uploadConcurrency: 1,
        largeObjectThreshold: 10,
        async ensureWriterLock() { return true },
        isStopped: () => false,
      })
      const result = await capture.runAgentStoreDbsSweep("s", false)
      assert.equal(result.complete, true)
      assert.equal(result.agentCount, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("sweeps every agent's databases, largest bundles first and small ones at the upload concurrency", async () => {
    const outcome = await withCapture({ committed: true }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      world.addAgent("a2", { "store.db": 200, "store.db-wal": 50 })
      world.addAgent("a3", {})
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.deepEqual((outcome.result as { summary: unknown }).summary, { name: "store.db", filesScanned: 2, filesUploaded: 2, bytesUploaded: 0, skippedUnchanged: 0, removed: 0, oversize: 0, failures: 0, metadataFailures: 0 })
    assert.equal((outcome.result as { complete: boolean }).complete, true)
    assert.equal((outcome.result as { agentCount: number }).agentCount, 2)
    // The larger bundle is captured first; the write-ahead log counts towards its size.
    assert.deepEqual(outcome.logs, [{ capture: "a2", targets: [["cat/agents/a2/store.db", 250]] }, { capture: "a1", targets: [["cat/agents/a1/store.db", 10]] }])
    assert.equal([...(outcome.result as { capturedThisSweep: Set<string> }).capturedThisSweep].length, 2)
  })

  it("leaves a database that is being written alone when asked", async () => {
    const skipped = await withCapture({ committed: true, skipLive: true, liveHandles: ["a1/store.db"] }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      world.addAgent("a2", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", true)
    })
    assert.deepEqual(skipped.logs.map((entry) => (entry as { capture: string }).capture), ["a2"])
    const kept = await withCapture({ committed: true, liveHandles: ["a1/store.db"] }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.deepEqual(kept.logs.map((entry) => (entry as { capture: string }).capture), ["a1"])
  })

  it("counts an agent whose database still needs recovery", async () => {
    const outcome = await withCapture({ committed: true, pendingAgent: "a1" }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      world.addAgent("a2", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.equal((outcome.result as { summary: { failures: number } }).summary.failures, 1)
    assert.deepEqual(outcome.logs.map((entry) => (entry as { capture: string }).capture), ["a2"])
  })

  it("counts a capture that failed without saying so, and a complete sweep needs every database durable", async () => {
    const failed = await withCapture({ committed: true, captureFails: "a1" }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.equal((failed.result as { summary: { failures: number } }).summary.failures, 1)
    const thrown = await withCapture({ committed: true, captureThrows: "a1" }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.equal((thrown.result as { summary: { failures: number } }).summary.failures, 1)
    assert.match(String(thrown.logs.find((entry) => typeof entry === "string") ?? ""), /capture failed/)
    const notDurable = await withCapture({ committed: true, durable: (relPath: string) => !relPath.includes("a2") }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      world.addAgent("a2", { "store.db": 10 })
      return await capture.runAgentStoreDbsSweep("store-1", false)
    })
    assert.equal((notDurable.result as { complete: boolean }).complete, false)
  })

  it("prunes leftovers, deleted agents and nested paths, and prunes nothing else", async () => {
    const manifest: [string, unknown][] = [
      ["cat/agents/a1/store.db", {}],
      ["cat/agents/gone/store.db", {}],
      ["cat/agents/a1/store.db.corrupt-1", {}],
      ["cat/agents/a1/store.db-wal", {}],
      ["cat/agents/a1/store.db.pending", {}],
      ["cat/agents/a1/store.db.replacement-x", {}],
      ["cat/agents/a1/nested/store.db", {}],
      ["other/agents/a1/store.db", {}],
      ["cat/agents/a1/other.db", {}],
    ]
    const outcome = await withCapture({ manifest }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.pruneMissingAgentStoreDbs("store-1")
    })
    assert.equal(outcome.result, 6)
    assert.deepEqual(outcome.manifest, ["cat/agents/a1/store.db", "other/agents/a1/store.db", "cat/agents/a1/other.db"])
  })

  it("captures one agent at a turn's end and says whether the manifest committed", async () => {
    const skipped = await withCapture({ stopped: true }, async (capture) => await capture.runAgentStoreDbSnapshot("a1"))
    assert.equal((skipped.result as { outcome: string }).outcome, "skipped")
    const noFiles = await withCapture({}, async (capture, world) => { world.addAgent("a1"); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.equal((noFiles.result as { outcome: string }).outcome, "skipped")
    const noLock = await withCapture({ lock: false }, async (capture, world) => { world.addAgent("a1", { "store.db": 10 }); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.equal((noLock.result as { outcome: string }).outcome, "skipped")
    assert.deepEqual(noLock.logs, [])
    const uploaded = await withCapture({ committed: true, writeManifest: false }, async (capture, world) => { world.addAgent("a1", { "store.db": 10 }); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.equal((uploaded.result as { outcome: string }).outcome, "uploaded")
    assert.equal((uploaded.result as { isCommitted: boolean }).isCommitted, true)
    assert.match(String(uploaded.logs.find((entry) => typeof entry === "string")), /uploaded/)
    const failed = await withCapture({ committed: true, captureFails: "a1" }, async (capture, world) => { world.addAgent("a1", { "store.db": 10 }); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.equal((failed.result as { outcome: string }).outcome, "error")
    assert.equal((failed.result as { summary: { failures: number } }).summary.failures, 1)
    // Bytes that went up but were never recorded as committed are an error, not an upload.
    const uncommitted = await withCapture({ committed: true, bundleCommitted: false, writeManifest: false }, async (capture, world) => { world.addAgent("a1", { "store.db": 10 }); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.deepEqual([(uncommitted.result as { outcome: string }).outcome, (uncommitted.result as { isCommitted: boolean }).isCommitted], ["error", false])
    assert.equal((uncommitted.result as { captureTrace: { failurePhase?: string } }).captureTrace.failurePhase, "manifest_commit")
  })

  it("checks the whole store against a directory that is not there", async () => {
    const outcome = await withCapture({}, async (capture, world) => {
      return await capture.verifyAgentDbsComplete(join(world.agents, "missing"), "cat", new Map(), new Set())
    })
    assert.equal(outcome.result, true)
  })

  it("forgets an agent that disappeared while its snapshot was being taken", async () => {
    const outcome = await withCapture({ committed: true, removeAgentOnCapture: "a1", manifest: [["cat/agents/a1/store.db", {}]] }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.runAgentStoreDbSnapshot("a1")
    })
    assert.equal((outcome.result as { summary: { removed: number } }).summary.removed, 1)
    assert.deepEqual(outcome.manifest, [])
    assert.equal(outcome.saves.length, 1)
  })

  it("does not write the manifest when an unchanged snapshot leaves it where it was", async () => {
    const outcome = await withCapture({ committed: true, writeManifest: false, manifest: [["cat/agents/a1/store.db", {}]] }, async (capture, world) => {
      world.addAgent("a1", { "store.db": 10 })
      return await capture.runAgentStoreDbSnapshot("a1")
    })
    assert.equal((outcome.result as { outcome: string }).outcome, "uploaded")
    assert.equal((outcome.result as { isCommitted: boolean }).isCommitted, true)
    assert.deepEqual(outcome.saves, [])
  })

  it("fails the snapshot when the manifest cannot be written", async () => {
    const outcome = await withCapture({ committed: true, saveThrows: true }, async (capture, world) => { world.addAgent("a1", { "store.db": 10 }); return await capture.runAgentStoreDbSnapshot("a1") })
    assert.equal((outcome.result as { outcome: string }).outcome, "error")
    assert.equal((outcome.result as { isCommitted: boolean }).isCommitted, false)
    assert.equal((outcome.result as { captureTrace: { failurePhase?: string } }).captureTrace.failurePhase, "manifest_commit")
    assert.match(String(outcome.logs.find((entry) => typeof entry === "string")), /failed/)
  })
});

describe("what a copy-in says", () => {
  const result = (overrides: Partial<CopyInResult> = {}): CopyInResult => ({ outcome: "failed", message: "boom", indexedEntries: 3, storeDatabases: 1, restoredFiles: 1, restoredBytes: 10, verifiedFiles: 1, issues: ["boom"], ...overrides });

  it("maps an outcome to an exit code, and to what a dashboard counts", () => {
    assert.deepEqual([outcomeToExitCode("hydrated"), outcomeToExitCode("noop"), outcomeToExitCode("failed")], [BOX_COPY_IN_EXIT_HYDRATED, BOX_COPY_IN_EXIT_NOOP, BOX_COPY_IN_EXIT_FAILED]);
    assert.equal(classifyCopyInMeteredOutcome(result({ outcome: "hydrated", message: "ok" })), "hydrated");
    assert.equal(classifyCopyInMeteredOutcome(result({ outcome: "noop", message: "empty" })), "empty");
    assert.equal(classifyCopyInMeteredOutcome(result({ message: "partial hydrate (1/3 files, 2 failures)" })), "partial");
    assert.equal(classifyCopyInMeteredOutcome(result()), "failed");
  });

  it("classifies a failure by what the first error says, and decides whether a retry makes sense", () => {
    assert.equal(classifyCopyInFailure(result({ issues: ["HTTP 401 unauthorized"] })), "auth");
    assert.equal(classifyCopyInFailure(result({ issues: ["no inference credential for copy-in"] })), "no-credential");
    assert.equal(classifyCopyInFailure(result({ issues: ["request timed out"] })), "timeout");
    assert.equal(classifyCopyInFailure(result({ issues: ["ENOTFOUND object.invalid"] })), "network");
    assert.equal(classifyCopyInFailure(result({ issues: ["NoSuchKey on the bucket"] })), "s3");
    assert.equal(classifyCopyInFailure(result({ issues: ["something else"] })), "unknown");
    assert.equal(classifyCopyInFailure(result({ message: "lock-held", issues: [] })), "lock-held");
    assert.equal(classifyCopyInFailure(result({ outcome: "hydrated", message: "ok" })), "");
    assert.equal(isTransientCopyInFailure(result({ issues: ["request timed out"] })), true);
    assert.equal(isTransientCopyInFailure(result({ issues: ["HTTP 401 unauthorized"] })), false);
    assert.equal(isTransientCopyInFailure(result({ message: "partial hydrate (1/3 files, 2 failures)" })), true);
    assert.equal(isTransientCopyInFailure(result({ outcome: "hydrated", message: "ok" })), false);
  });

  it("buckets a reason, redacts an error, and builds the status the desktop reads", () => {
    assert.equal(bucketCopyInReason(result({ outcome: "hydrated", message: "ok" })), "hydrated");
    assert.equal(bucketCopyInReason(result({ outcome: "noop", message: "the store is empty" })), "noop");
    assert.equal(bucketCopyInReason(result({ message: "partial hydrate (1/3 files)" })), "partial-hydrate");
    assert.equal(bucketCopyInReason(result({ message: "store manifest unreadable: x" })), "manifest-unreadable");
    assert.equal(bucketCopyInReason(result({ message: "the download threw: x" })), "download-error");
    const redacted = redactCopyInErrorForTelemetry("failed at https://object.invalid/a/b for account abcdefghijklmnopqrstuvwxyz123456 in /home/box/secret.txt");
    assert.equal(redacted.includes("https://"), false);
    assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(redacted.length <= 200, true);
    const status = buildCopyInStatusFromResult(result({ outcome: "hydrated", message: "ok", issues: [] }));
    assert.deepEqual([status.phase, status.outcome, status.restored, status.total], ["done", "hydrated", 1, 3]);
    assert.equal(buildCopyInStatusFromResult(result()).phase, "failed");
    assert.equal(empty("nothing").outcome, "noop");
  });

  it("describes a watchdog tick as stuck or slow, with the symlink step it is in", () => {
    const stuck = buildCopyInWatchdogEvent({ progressedSinceLastTick: false, progress: { total: 10, files: 4, bytes: 100 }, elapsedMs: 1_000, thresholdMs: 500, trace: { copyStage: "symlink", symlinksInFlight: 2, activeSymlinkSteps: { "rename-temp": 2 } } });
    assert.deepEqual([stuck.level, stuck.metadata.outcome, stuck.metadata.stage, stuck.metadata.active_symlink_steps], ["warn", "stuck", "symlink", "rename-temp:2"]);
    const slow = buildCopyInWatchdogEvent({ progressedSinceLastTick: true, progress: { total: 10, files: 4, bytes: 100 }, elapsedMs: 1_000, thresholdMs: 500 });
    assert.deepEqual([slow.level, slow.metadata.outcome, slow.metadata.active_symlink_steps], ["info", "slow", undefined]);
  });

  it("reads its limits from the environment, and falls back when the value is not a limit", () => {
    assert.equal(resolveCopyInConcurrency({}), undefined);
    assert.equal(resolveCopyInConcurrency({ SLATE_BOX_STORE_COPY_IN_CONCURRENCY: "4" }), 4);
    assert.equal(resolveCopyInConcurrency({ SLATE_BOX_STORE_COPY_IN_CONCURRENCY: "0" }), undefined);
    assert.equal(resolveCopyInAttempts({}), COPY_IN_HYDRATE_ATTEMPTS);
    assert.equal(resolveCopyInAttempts({ SLATE_BOX_COPY_IN_ATTEMPTS: "-2" }), COPY_IN_HYDRATE_ATTEMPTS);
    assert.equal(resolveCopyInStuckThresholdMs({}), COPY_IN_STUCK_THRESHOLD_MS);
    assert.equal(resolveCopyInStuckThresholdMs({ SLATE_BOX_COPY_IN_STUCK_MS: "9000" }), 9_000);
  });

  it("writes the status file atomically, and throttles unless told to force", () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-status-"));
    try {
      const path = join(directory, "status.json");
      const writes: number[] = [];
      const write = makeCopyInStatusWriter(path, () => {
        writes.push(1);
        return writes.length === 1 ? 0 : 100;
      });
      write({ phase: "copying" }, { force: true });
      assert.equal(existsSync(path), true);
      write({ phase: "copying", restored: 2 });
      // Still inside the throttle window: the file is unchanged.
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { phase: "copying" });
      write({ phase: "done" }, { force: true });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { phase: "done" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Restoring a box's store
// ---------------------------------------------------------------------------------------------

/** A restore over a real target directory and a scripted object store, manifest store and pack pipeline. */
function restoreWorld(options: { threshold?: number; corruptStream?: boolean; getThrows?: boolean; getToFileThrows?: boolean; diskSpace?: boolean; prefetchThrows?: boolean; packRestored?: boolean; chownThrows?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "slate-restore-"));
  const target = join(root, "target");
  mkdirSync(target, { recursive: true });
  const blobs = new Map<string, Uint8Array>();
  const manifest = new Map<string, Record<string, unknown>>();
  const calls: unknown[][] = [];
  const traces: Array<Record<string, unknown>> = [];
  const progress: Array<Record<string, number>> = [];
  const logs: string[] = [];
  const add = (relPath: string, text: string, mode?: number) => {
    const bytes = new TextEncoder().encode(text);
    const sha = createHash("sha256").update(bytes).digest("hex");
    blobs.set(sha, bytes);
    manifest.set(relPath, { kind: "file", sha, size: bytes.length, ...(mode === undefined ? {} : { mode }) });
  };
  const addLink = (relPath: string, linkTarget: string) => manifest.set(relPath, { kind: "symlink", target: linkTarget });
  const store = {
    async get(key: string) {
      calls.push(["get", key.split("/").pop()]);
      if (options.getThrows === true) throw new Error("download failed");
      return blobs.get(key.split("/").pop()!) ?? null;
    },
    async getToFile(key: string, tmpPath: string, request: unknown) {
      calls.push(["getToFile", key.split("/").pop(), request]);
      if (options.getToFileThrows === true) throw new Error("stream failed");
      const bytes = blobs.get(key.split("/").pop()!);
      if (bytes === undefined) return null;
      writeFileSync(tmpPath, options.corruptStream === true ? new Uint8Array([1, 2, 3]) : bytes);
      return bytes.length;
    },
    async prefetchReads(keys: string[]) {
      calls.push(["prefetch", keys.length]);
      if (options.prefetchThrows === true) throw new Error("prefetch failed");
    },
  };
  const port = {
    resolveStoreId: async () => "store-1",
    objectStore: () => store,
    manifestStore: { manifest: "cached" as unknown, async loadManifest() { calls.push(["loadManifest"]); return manifest; } },
    log: (message: string) => logs.push(message.replaceAll(root, "<root>")),
    downloadConcurrency: 2,
    largeObjectThreshold: options.threshold ?? 16,
    downloadByteBudget: 1024,
    hasDiskSpaceForLargeObject: async () => options.diskSpace ?? true,
    discardTemp: async ({ tmpPath, label }: { tmpPath: string; label: string }) => {
      calls.push(["discardTemp", label]);
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    },
    packPipeline: {
      restoreBulkSmallFromPacks: async (restoreOptions: { groups: Map<string, { relPaths: string[]; size: number }>; recordRestoredPath(size: number): void }) => {
        calls.push(["packRestore", restoreOptions.groups.size]);
        if (options.packRestored !== true) return new Set<string>();
        const restored = new Set<string>();
        for (const group of restoreOptions.groups.values()) for (const relPath of group.relPaths) { restored.add(relPath); restoreOptions.recordRestoredPath(group.size); }
        return restored;
      },
    },
  };
  const downloader = new BoxStoreDownload(port as never);
  return { root, target, manifest, blobs, calls, traces, progress, logs, downloader, manifestStore: port.manifestStore, add, addLink,
    download: async (extra: Record<string, unknown> = {}) => {
      const summary = await downloader.download(target, { onTrace: (trace) => traces.push(trace as unknown as Record<string, unknown>), onProgress: (entry) => progress.push(entry), ...extra });
      const tree: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const name of (() => { try { return readdirSync(dir).sort(); } catch { return []; } })()) {
          const full = join(dir, name);
          const stats = lstatSync(full);
          const rel = prefix === "" ? name : prefix + "/" + name;
          if (stats.isSymbolicLink()) tree.push(rel + " -> " + readlinkSync(full));
          else if (stats.isDirectory()) { tree.push(rel + "/"); walk(full, rel); }
          else tree.push(rel + " = " + readFileSync(full, "utf8") + " @ " + (stats.mode & 0o777));
        }
      };
      walk(target, "");
      return { summary, tree };
    } };
}

describe("restoring a box's store", () => {
  it("writes verified files into their places and reports them", async () => {
    const world = restoreWorld();
    try {
      world.add("dir/a.txt", "alpha");
      world.add("dir/b.txt", "beta", 0o640);
      const { summary, tree } = await world.download();
      assert.deepEqual(summary, { manifestEntries: 2, files: 2, bytes: 9, verified: 2, failures: [] });
      assert.equal(tree.includes("dir/a.txt = alpha @ 420") || tree.includes("dir/a.txt = alpha @ 438"), true);
      assert.equal(tree.includes("dir/b.txt = beta @ 416"), true);
      assert.equal(tree.some((entry) => entry.includes(".box-store-part-")), false);
      assert.deepEqual(world.progress.at(-1), { files: 2, bytes: 9, verified: 2, total: 2 });
      assert.deepEqual(world.calls.slice(0, 1).map((call) => call[0]), ["loadManifest"]);
      assert.equal(world.calls.filter((call) => call[0] === "get").length, 2);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("refuses paths outside the root and paths the manifest cannot name", async () => {
    const world = restoreWorld();
    try {
      world.manifest.set("../escape", { kind: "file", sha: "x", size: 1 });
      world.manifest.set("", { kind: "file", sha: "y", size: 1 });
      world.add("safe.txt", "safe");
      const { summary } = await world.download();
      assert.deepEqual(summary.failures, ["../escape: unsafe manifest path", ": unsafe manifest path"]);
      assert.equal(summary.files, 1);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("drops a cached manifest before a restore, and keeps one it is given", async () => {
    const world = restoreWorld();
    try {
      world.add("a.txt", "a");
      const { summary } = await world.download();
      assert.equal(world.calls.filter((call) => call[0] === "loadManifest").length, 1);
      assert.equal(world.manifestStore.manifest, undefined);
      assert.equal(summary.manifestEntries, 1);
      const given = restoreWorld();
      try {
        given.add("b.txt", "bb");
        const provided = await given.download({ manifest: new Map([["b.txt", { kind: "file", sha: createHash("sha256").update(new TextEncoder().encode("bb")).digest("hex"), size: 2 }]]) });
        assert.equal(given.calls.filter((call) => call[0] === "loadManifest").length, 0);
        assert.equal(provided.summary.files, 1);
      } finally {
        rmSync(given.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("counts a failed blob as a failure for each of its paths", async () => {
    const failing = restoreWorld({ getThrows: true });
    try {
      failing.add("a.txt", "alpha");
      failing.add("b.txt", "beta");
      const { summary } = await failing.download();
      assert.deepEqual(summary.failures.sort(), ["a.txt: download failed", "b.txt: download failed"]);
      assert.equal(summary.files, 0);
    } finally {
      rmSync(failing.root, { recursive: true, force: true });
    }
    const missing = restoreWorld();
    try {
      missing.manifest.set("gone.txt", { kind: "file", sha: "gone", size: 3 });
      const bytes = new TextEncoder().encode("good");
      const sha = createHash("sha256").update(bytes).digest("hex");
      missing.manifest.set("bad-size.txt", { kind: "file", sha, size: 3 });
      missing.blobs.set(sha, bytes);
      const { summary } = await missing.download();
      assert.deepEqual(summary.failures.sort(), ["bad-size.txt: sha/size mismatch", "gone.txt: blob gone missing"]);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
  });

  it("streams a large blob once and copies it to its other paths", async () => {
    const world = restoreWorld({ threshold: 8 });
    try {
      const text = "a".repeat(32);
      world.add("one.bin", text);
      world.add("two.bin", text);
      const { summary, tree } = await world.download();
      assert.equal(summary.files, 2);
      assert.equal(summary.verified, 2);
      assert.equal(world.calls.filter((call) => call[0] === "getToFile").length, 1);
      assert.equal(world.calls.filter((call) => call[0] === "get").length, 0);
      assert.equal(tree.filter((entry) => entry.startsWith("one.bin =") || entry.startsWith("two.bin =")).length, 2);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("refuses a large blob it cannot fit or cannot read", async () => {
    const noSpace = restoreWorld({ threshold: 8, diskSpace: false });
    try {
      noSpace.add("big.bin", "a".repeat(32));
      const { summary } = await noSpace.download();
      assert.deepEqual(summary.failures, ["big.bin: insufficient disk space for a 32B restore (x2 required)"]);
      assert.equal(noSpace.calls.some((call) => call[0] === "getToFile"), false);
    } finally {
      rmSync(noSpace.root, { recursive: true, force: true });
    }
    const corrupt = restoreWorld({ threshold: 8, corruptStream: true });
    try {
      corrupt.add("big.bin", "a".repeat(32));
      const { summary } = await corrupt.download();
      assert.deepEqual(summary.failures, ["big.bin: sha/size mismatch"]);
    } finally {
      rmSync(corrupt.root, { recursive: true, force: true });
    }
    const missing = restoreWorld({ threshold: 8 });
    try {
      missing.manifest.set("gone.bin", { kind: "file", sha: "gone", size: 32 });
      const { summary } = await missing.download();
      assert.deepEqual(summary.failures, ["gone.bin: blob gone missing"]);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
    }
    const throwing = restoreWorld({ threshold: 8, getToFileThrows: true });
    try {
      throwing.add("big.bin", "a".repeat(32));
      const { summary } = await throwing.download();
      assert.deepEqual(summary.failures, ["big.bin: stream failed"]);
    } finally {
      rmSync(throwing.root, { recursive: true, force: true });
    }
  });

  it("verifies a file that is already in place and refreshes its mode", async () => {
    const world = restoreWorld();
    try {
      world.add("same.txt", "same", 0o644);
      writeFileSync(join(world.target, "same.txt"), "same", { mode: 0o600 });
      const { summary, tree } = await world.download();
      assert.equal(summary.verified, 1);
      assert.equal(world.calls.filter((call) => call[0] === "get").length, 0);
      assert.equal(tree.includes("same.txt = same @ 420"), true);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("lets a pack carry the bulk and restores what it left", async () => {
    const world = restoreWorld({ packRestored: true });
    try {
      world.add("bulk/a.txt", "bulk-a");
      world.add("bulk/b.txt", "bulk-b");
      const { summary } = await world.download();
      assert.equal(world.calls.some((call) => call[0] === "packRestore"), true);
      assert.equal(summary.files, 2);
      assert.equal(summary.verified, 2);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("falls back when a read prefetch fails", async () => {
    const world = restoreWorld({ prefetchThrows: true });
    try {
      world.add("bulk/a.txt", "bulk-a");
      const { summary } = await world.download();
      assert.equal(summary.files, 1);
      assert.equal(world.logs.some((line) => line.includes("read prefetch failed")), true);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("matches, recreates and refuses symlinks, tracing each step", async () => {
    const world = restoreWorld();
    try {
      world.add("dir/file.txt", "target");
      world.addLink("dir/good-link", "file.txt");
      world.addLink("dir/wrong-link", "other.txt");
      world.addLink("dir/escape-link", "../../outside");
      mkdirSync(join(world.target, "dir"), { recursive: true });
      writeFileSync(join(world.target, "dir", "file.txt"), "target");
      symlinkSync("file.txt", join(world.target, "dir", "good-link"));
      const { summary, tree } = await world.download();
      assert.deepEqual(summary.failures, ["dir/escape-link: unsafe symlink target"]);
      assert.equal(tree.includes("dir/good-link -> file.txt"), true);
      assert.equal(tree.includes("dir/wrong-link -> other.txt"), true);
      const steps = world.traces.filter((trace) => trace.event === "symlink-step-started").map((trace) => trace.symlinkStep);
      for (const step of ["prepare-parent", "match-existing", "apply-owner", "verify-target", "create-temp", "rename-temp", "cleanup-temp"]) {
        assert.equal(steps.includes(step), true);
      }
      assert.equal(world.traces.at(-1)?.event, "symlink-phase-finished");
      const firstLinkSteps = world.traces.filter((trace) => trace.symlinkOrdinal === 1 && trace.event === "symlink-step-started").map((trace) => trace.symlinkStep);
      assert.equal(firstLinkSteps.includes("match-existing"), true);
      assert.equal(firstLinkSteps.includes("create-temp"), false);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("applies the owner the restore was given", async () => {
    const world = restoreWorld();
    try {
      world.add("owner.txt", "owner");
      const chowns: unknown[][] = [];
      const { summary } = await world.download({ uid: 7, gid: 9, chown: async (path: string, uid: number, gid: number) => { chowns.push([path.replaceAll(world.root, "<root>"), uid, gid]); } });
      assert.equal(summary.files, 1);
      assert.equal(chowns.length >= 1, true);
      assert.deepEqual(chowns.at(-1)?.slice(1), [7, 9]);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("replaces what is in the way and refuses a root that is not a directory", async () => {
    const world = restoreWorld();
    try {
      world.add("blocked.txt", "blocked");
      mkdirSync(join(world.target, "blocked.txt"), { recursive: true });
      writeFileSync(join(world.target, "blocked.txt", "inside"), "x");
      const { tree } = await world.download();
      assert.equal(tree.includes("blocked.txt = blocked @ 420"), true);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
    const bad = restoreWorld();
    try {
      bad.add("a.txt", "a");
      rmSync(bad.target, { recursive: true, force: true });
      writeFileSync(bad.target, "not a directory");
      const { summary } = await bad.download();
      assert.equal(summary.failures.length, 1);
      assert.match(String(summary.failures[0]), /restore target root is not a directory/);
    } finally {
      rmSync(bad.root, { recursive: true, force: true });
    }
  });

  it("records a file whose metadata could not be applied, and cleans its temporary", async () => {
    const world = restoreWorld({ chownThrows: true });
    try {
      world.add("a.txt", "a");
      const throwing = restoreWorld();
      try {
        throwing.add("a.txt", "a");
        const { summary } = await throwing.download({ uid: 1, gid: 1, chown: async () => { throw new Error("chown failed"); } });
        assert.equal(summary.files, 0);
        assert.equal(summary.failures.length, 1);
        assert.match(String(summary.failures[0]), /chown failed/);
        assert.equal(throwing.calls.filter((call) => call[0] === "discardTemp").length >= 1, true);
      } finally {
        rmSync(throwing.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });
});


describe("restoring a box's store, at its edges", () => {
  it("refuses to hash a directory or to overwrite a copy destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "slate-hash-edges-"));
    try {
      mkdirSync(join(root, "dir"));
      await assert.rejects(() => sha256File(join(root, "dir")), /hash source is not a regular file/);
      writeFileSync(join(root, "source"), "bytes");
      const destination = join(root, "destination");
      await copyFileHashing(join(root, "source"), destination);
      await assert.rejects(() => copyFileHashing(join(root, "source"), destination), /EEXIST/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes a directory where a file was in the way", async () => {
    const world = restoreWorld();
    try {
      world.add("dir/a.txt", "inside");
      writeFileSync(join(world.target, "dir"), "a file where a directory is needed");
      const { summary, tree } = await world.download();
      assert.deepEqual(summary.failures, []);
      assert.equal(tree.includes("dir/a.txt = inside @ 420"), true);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });

  it("restores the critical files before the bulk a pack carries", async () => {
    const world = restoreWorld();
    try {
      world.add("store.db", "database");
      world.add("other.txt", "other");
      const { summary } = await world.download();
      assert.equal(summary.files, 2);
      const firstGet = world.calls.findIndex((call) => call[0] === "get");
      const packRestore = world.calls.findIndex((call) => call[0] === "packRestore");
      assert.equal(firstGet !== -1 && packRestore !== -1 && firstGet < packRestore, true);
    } finally {
      rmSync(world.root, { recursive: true, force: true });
    }
  });
});

