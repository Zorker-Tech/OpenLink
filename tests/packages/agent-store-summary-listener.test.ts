import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { notifySummaryMetrics, notifySummaryResult } from "../../source/packages/agent-store-sync/summary-listener.ts";

const summarise = (over: Record<string, unknown> = {}) => ({
  durationMs: 1_000,
  filesPushed: 3,
  filesPulled: 4,
  filesSkipped: 5,
  bytesPushed: 6,
  bytesPulled: 7,
  refusals: 8,
  filesConflicted: 9,
  conflictProtectionDowngrades: 10,
  legacyProbes: 11,
  pushEntriesParked: 12,
  pullsDeferred: 13,
  filesDeletedRemote: 14,
  filesDeletedLocal: 15,
  deleteConflicts: 16,
  scanDeletesJournaled: 17,
  recoveryDisarms: 18,
  identityRecoveryWipeFailed: 19,
  legacyRowsRestored: 20,
  listingComplete: true,
  errors: [],
  conflicts: [],
  ...over,
});

describe("what a sync round reports about its paths", () => {
  it("sends symlink refusals and full disks to the listener, hashed and without the path", () => {
    const events: unknown[][] = [];
    const listener = {
      onSymlinkRefused: (event: unknown) => events.push(["symlink", event]),
      onDiskFull: (event: unknown) => events.push(["disk", event]),
    };
    const errors = [
      { code: "symlink_refused", relPath: "a/b.txt" },
      { code: "toctou_swap_refused", relPath: "c/d.txt" },
      { code: "fs_read_failed", relPath: "e/f.txt" },
      { code: "fs_write_failed" },
      { code: "upload_failed", relPath: "g/h.txt" },
    ];
    notifySummaryResult({ agentId: "agent", summary: summarise({ errors }) as never, listener, pathHashSalt: "salt" });
    assert.deepEqual(events.map((event) => event[0]), ["symlink", "symlink", "disk", "disk"]);
    assert.equal(typeof (events[0]?.[1] as Record<string, unknown>).relPathHash, "string");
    assert.equal(((events[0]?.[1] as Record<string, unknown>).relPathHash as string).length, 32);
    assert.equal(JSON.stringify(events).includes("a/b.txt"), false, "the path itself is never reported");
    assert.deepEqual(events[1]?.[1], { agentId: "agent", op: "fs_read", relPathHash: (events[1]?.[1] as Record<string, unknown>).relPathHash });
    assert.deepEqual(events[2]?.[1], { agentId: "agent", op: "fs_read" });
    assert.deepEqual(events[3]?.[1], { agentId: "agent", op: "fs_write" });
  });

  it("refuses to report a symlink refusal without a salt, after reporting everything it can", () => {
    const events: unknown[][] = [];
    const listener = { onDiskFull: (event: unknown) => events.push(["disk", event]) };
    const errors = [{ code: "fs_write_failed" }, { code: "symlink_refused", relPath: "x" }];
    assert.throws(
      () => notifySummaryResult({ agentId: "agent", summary: summarise({ errors }) as never, listener }),
      { message: "notifySummaryResult: pathHashSalt is required when emitting symlink-refused events" },
    );
    assert.equal(events.length, 1, "the disk event was reported before the salt refusal");
    assert.doesNotThrow(() => notifySummaryResult({ agentId: "agent", summary: summarise() as never, listener }));
    assert.doesNotThrow(() => notifySummaryResult({ agentId: "agent", summary: summarise({ errors }) as never, listener: undefined }));
  });

  it("emits a round event, one error event per failure and one conflict event per conflict", () => {
    const events: unknown[][] = [];
    const emitter = {
      onRoundCompleted: (event: unknown) => events.push(["round", event]),
      onError: (event: unknown) => events.push(["error", event]),
      onConflict: (event: unknown) => events.push(["conflict", event]),
    };
    const errors = [
      { code: "upload_failed", relPath: "a", timeoutClass: "slow" },
      { code: "something_else" },
    ];
    const conflicts = [{ relPath: "p", conflictRelPath: "p.conflict" }];
    notifySummaryMetrics({ agentId: "agent", summary: summarise({ errors, conflicts }) as never, metricsEmitter: emitter, pathHashSalt: "salt" });
    assert.deepEqual(events.map((event) => event[0]), ["round", "error", "error", "conflict"]);
    const round = events[0]?.[1] as Record<string, unknown>;
    assert.equal(round.agentId, "agent");
    assert.equal(round.filesPushed, 3);
    assert.equal(round.errorCount, 2);
    assert.equal(round.failed, true);
    assert.equal(round.walkMs, 0, "an absent phase is reported as zero");
    assert.equal(round.scope, "full");
    assert.deepEqual(events[1]?.[1], {
      agentId: "agent",
      op: "blob_put",
      errorClass: "upload_failed",
      relPathHash: (events[1]?.[1] as Record<string, unknown>).relPathHash,
      timeoutClass: "slow",
    });
    assert.equal((events[2]?.[1] as Record<string, unknown>).op, "unknown");
    const conflict = events[3]?.[1] as Record<string, unknown>;
    assert.equal(conflict.storeKind, "unknown");
    assert.equal(typeof conflict.relPathHash, "string");
    assert.equal(typeof conflict.conflictRelPathHash, "string");
    assert.equal(conflict.relPathHash === conflict.conflictRelPathHash, false);
  });

  it("keeps the first failure reporting raised, after everything was reported", () => {
    const events: unknown[][] = [];
    const emitter = {
      onRoundCompleted: () => { throw new Error("round failed"); },
      onError: () => { throw new Error("error failed"); },
      onConflict: () => { throw new Error("conflict failed"); },
    };
    assert.throws(
      () => notifySummaryMetrics({ agentId: "agent", summary: summarise({ errors: [{ code: "delete_failed" }], conflicts: [{ relPath: "p", conflictRelPath: "q" }] }) as never, metricsEmitter: emitter, pathHashSalt: "salt" }),
      { message: "round failed" },
    );
    const listener = { onSymlinkRefused: () => { throw new Error("listener failed"); } };
    assert.doesNotThrow(
      () => notifySummaryResult({ agentId: "agent", summary: summarise({ errors: [{ code: "symlink_refused", relPath: "x" }] }) as never, listener, pathHashSalt: "salt" }),
      "a listener that throws is contained",
    );
  });

  it("reports the store kind of the agent a conflict came from", () => {
    const kinds: unknown[] = [];
    const emitter = { onConflict: (event: unknown) => kinds.push((event as Record<string, unknown>).storeKind) };
    for (const agentId of ["0f8fad5b-d9cb-469f-a165-70867728950e", "unknown-thing", ""]) {
      notifySummaryMetrics({ agentId, summary: summarise({ conflicts: [{ relPath: "p", conflictRelPath: "q" }] }) as never, metricsEmitter: emitter, pathHashSalt: "salt" });
    }
    assert.deepEqual(kinds, ["local", "unknown", "unknown"]);
  });
});