import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NOOP_METRICS_EMITTER, buildRoundCompletedEvent } from "../../source/packages/agent-store-sync/metrics-emitter.ts";

/** A round that counted something in every field, so a missing one shows. */
const counted = {
  durationMs: 12,
  filesPushed: 1,
  filesPulled: 2,
  filesSkipped: 3,
  bytesPushed: 4,
  bytesPulled: 5,
  refusals: 6,
  filesConflicted: 7,
  conflictProtectionDowngrades: 8,
  legacyProbes: 9,
  pushEntriesParked: 10,
  pullsDeferred: 11,
  filesDeletedRemote: 12,
  filesDeletedLocal: 13,
  deleteConflicts: 14,
  scanDeletesJournaled: 15,
  recoveryDisarms: 16,
  identityRecoveryWipeFailed: 17,
  legacyRowsRestored: 18,
  listingComplete: true,
  errors: [] as unknown[],
};

const event = (summary: Record<string, unknown>) => buildRoundCompletedEvent({ agentId: "agent-1", summary: summary as never });

describe("one round, as the telemetry reads it", () => {
  it("reports the round's own name and every count it collected", () => {
    const reported = event(counted);
    assert.equal(reported["agentId"], "agent-1");
    for (const [key, value] of Object.entries(counted)) {
      if (key === "errors") continue;
      assert.equal(reported[key], value, key);
    }
    // the name, twenty counts, errorCount, failed, six phases and the scope
    assert.equal(Object.keys(reported).length, 30);
  });

  it("says whether the round failed, and how many errors it had", () => {
    assert.equal(event(counted)["failed"], false);
    assert.equal(event(counted)["errorCount"], 0);
    const failed = event({ ...counted, errors: [new Error("a"), new Error("b")] });
    assert.equal(failed["failed"], true);
    assert.equal(failed["errorCount"], 2);
    assert.equal("errors" in failed, false, "the errors themselves are counted, not carried");
  });

  it("reports a phase that was not timed as no time at all", () => {
    const untimed = event(counted);
    for (const phase of ["walkMs", "hashMs", "presignMs", "uploadMs", "listMs", "downloadMs"]) assert.equal(untimed[phase], 0, phase);
    const timed = event({ ...counted, walkMs: 7, hashMs: 0, presignMs: 1, uploadMs: 2, listMs: 3, downloadMs: 4 });
    assert.deepEqual(["walkMs", "hashMs", "presignMs", "uploadMs", "listMs", "downloadMs"].map((phase) => timed[phase]), [7, 0, 1, 2, 3, 4]);
  });

  it("calls a round that did not say what it covered a full one", () => {
    assert.equal(event(counted)["scope"], "full");
    assert.equal(event({ ...counted, scope: "incremental" })["scope"], "incremental");
    assert.equal(event({ ...counted, scope: "" })["scope"], "", "an empty scope is what it was told, not a missing one");
  });

  it("keeps the order the telemetry reads it in", () => {
    assert.deepEqual(Object.keys(event(counted)).slice(0, 4), ["agentId", "durationMs", "filesPushed", "filesPulled"]);
    const keys = Object.keys(event(counted));
    assert.deepEqual(keys.slice(keys.indexOf("failed"), keys.indexOf("failed") + 3), ["failed", "walkMs", "hashMs"]);
    assert.equal(keys.at(-1), "scope");
  });
});

describe("a caller that wants no metrics", () => {
  it("gets every hook, doing nothing and answering nothing", () => {
    const hooks = ["onDiskFull", "onSymlinkRefused", "onNetworkError", "onRoundCompleted", "onRoundLifecycle", "onLockEvent", "onResumeDetected", "onDirtyPassiveStalled", "onError", "onConflict", "recordWriteBarrier", "tokenMinted", "tokenRefreshUnauthorized", "tokenMintNegativeCached", "tokenMintFailureCached"];
    assert.deepEqual(Object.keys(NOOP_METRICS_EMITTER), hooks);
    for (const hook of hooks) {
      const noop = (NOOP_METRICS_EMITTER as Record<string, (...args: unknown[]) => unknown>)[hook]!;
      assert.equal(noop({ agentId: "a" }, 1, "anything"), undefined, hook);
    }
    assert.equal(Object.isFrozen(NOOP_METRICS_EMITTER), true);
  });
});
