/**
 * The box store's smaller decisions: what a path is allowed to be, what a manifest may hold, when a cycle can say it is
 * complete, and what a copy-in tells the platform when it does not finish.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { copyFileHashing, makeInFlightByteBudget, resolveRestoreDestination, sha256File, symlinkTargetStaysWithinRoot } from "../../source/host/boxes/box-store-sync/box-store-download.ts";
import { dedupeNestedRoots, globToRegExp, walkNodes } from "../../source/host/boxes/box-store-sync/box-store-transfer.ts";
import { hasManifestPathConflict, parseManifest, BoxStoreUnsupportedManifestVersionError, BoxStoreManifestPathConflictError, BoxStoreManifestRevisionState, countStoreDbManifestEntries, getStoreDbManifestAgentIds, countAgentDirManifestEntries } from "../../source/host/boxes/box-store-sync/box-store-manifest.ts";
import { evaluateBoxStoreFlush, boxStoreSyncCycleTelemetry, type BoxStoreCycleSummary } from "../../source/host/boxes/box-store-sync/box-store-sync.ts";
import { aggregateStoreDbSweepOutcome, boxStoreDbCaptureTelemetry } from "../../source/host/boxes/box-store-sync/store-db-capture.ts";
import { isCriticalRelPath } from "../../source/host/boxes/box-store-sync/box-store-download.ts";
import {
  bucketCopyInReason,
  buildCopyInStatusFromResult,
  buildCopyInWatchdogEvent,
  classifyCopyInFailure,
  classifyCopyInMeteredOutcome,
  empty,
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
  type CopyInResult,
} from "../../source/host/boxes/box-store-sync/box-copy-in.ts";



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

describe("what a copy-in says", () => {
  const result = (overrides: Partial<CopyInResult> = {}): CopyInResult => ({ outcome: "failed", reason: "boom", manifestEntries: 3, storeDbEntries: 1, files: 1, bytes: 10, verified: 1, failures: ["boom"], ...overrides });

  it("maps an outcome to an exit code, and to what a dashboard counts", () => {
    assert.deepEqual([outcomeToExitCode("hydrated"), outcomeToExitCode("noop"), outcomeToExitCode("failed")], [BOX_COPY_IN_EXIT_HYDRATED, BOX_COPY_IN_EXIT_NOOP, BOX_COPY_IN_EXIT_FAILED]);
    assert.equal(classifyCopyInMeteredOutcome(result({ outcome: "hydrated", reason: "ok" })), "hydrated");
    assert.equal(classifyCopyInMeteredOutcome(result({ outcome: "noop", reason: "empty" })), "empty");
    assert.equal(classifyCopyInMeteredOutcome(result({ reason: "partial hydrate (1/3 files, 2 failures)" })), "partial");
    assert.equal(classifyCopyInMeteredOutcome(result()), "failed");
  });

  it("classifies a failure by what the first error says, and decides whether a retry makes sense", () => {
    assert.equal(classifyCopyInFailure(result({ failures: ["HTTP 401 unauthorized"] })), "auth");
    assert.equal(classifyCopyInFailure(result({ failures: ["no inference credential for copy-in"] })), "no-credential");
    assert.equal(classifyCopyInFailure(result({ failures: ["request timed out"] })), "timeout");
    assert.equal(classifyCopyInFailure(result({ failures: ["ENOTFOUND object.invalid"] })), "network");
    assert.equal(classifyCopyInFailure(result({ failures: ["NoSuchKey on the bucket"] })), "s3");
    assert.equal(classifyCopyInFailure(result({ failures: ["something else"] })), "unknown");
    assert.equal(classifyCopyInFailure(result({ reason: "lock-held", failures: [] })), "lock-held");
    assert.equal(classifyCopyInFailure(result({ outcome: "hydrated", reason: "ok" })), "");
    assert.equal(isTransientCopyInFailure(result({ failures: ["request timed out"] })), true);
    assert.equal(isTransientCopyInFailure(result({ failures: ["HTTP 401 unauthorized"] })), false);
    assert.equal(isTransientCopyInFailure(result({ reason: "partial hydrate (1/3 files, 2 failures)" })), true);
    assert.equal(isTransientCopyInFailure(result({ outcome: "hydrated", reason: "ok" })), false);
  });

  it("buckets a reason, redacts an error, and builds the status the desktop reads", () => {
    assert.equal(bucketCopyInReason(result({ outcome: "hydrated", reason: "ok" })), "hydrated");
    assert.equal(bucketCopyInReason(result({ outcome: "noop", reason: "the store is empty" })), "noop");
    assert.equal(bucketCopyInReason(result({ reason: "partial hydrate (1/3 files)" })), "partial-hydrate");
    assert.equal(bucketCopyInReason(result({ reason: "store manifest unreadable: x" })), "manifest-unreadable");
    assert.equal(bucketCopyInReason(result({ reason: "the download threw: x" })), "download-error");
    const redacted = redactCopyInErrorForTelemetry("failed at https://object.invalid/a/b for account abcdefghijklmnopqrstuvwxyz123456 in /home/box/secret.txt");
    assert.equal(redacted.includes("https://"), false);
    assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(redacted.length <= 200, true);
    const status = buildCopyInStatusFromResult(result({ outcome: "hydrated", reason: "ok", failures: [] }));
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
