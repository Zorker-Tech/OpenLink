/**
 * Reviewing what an automation and a cloud agent did, the store's writer lock and its local index.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON, SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION } from "../../source/host/runner/slate-automation-auto-review.ts";
import { LIFECYCLE_REVIEW_UNAVAILABLE_REASON, SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS, SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON } from "../../source/host/runner/slate-cloud-agent-auto-review.ts";
import { STORE_LOCK_MTIME_UPDATE_MS, STORE_LOCK_STALE_MS, StoreLockError, tryAcquireStoreLock } from "../../source/packages/agent-store-sync/store-lock.ts";
import { LocalAgentStoreIndex, LocalIndexError, META_DELETION_ARMED } from "../../source/packages/agent-store-sync/local-index.ts";

describe("reviewing what an automation did", () => {
  it("names the action it reviews and the reason a classifier failed", () => {
    assert.equal(SLATE_AUTOMATION_WRITE_CLASSIFIER_TARGET_ACTION, "slate_automation_write");
    assert.equal(SLATE_AUTOMATION_WRITE_CLASSIFIER_ERROR_REASON.length > 0, true);
  });
});

describe("reviewing what a cloud agent did", () => {
  it("names the actions it reviews and why a lifecycle review may be unavailable", () => {
    assert.equal(SLATE_CLOUD_AGENT_AUTO_REVIEW_ACTIONS.length, 2);
    assert.equal(SLATE_CLOUD_AGENT_CLASSIFIER_ERROR_REASON.length > 0, true);
    assert.equal(LIFECYCLE_REVIEW_UNAVAILABLE_REASON.length > 0, true);
  });
});

describe("one writer at a time in a store", () => {
  it("refreshes while held and treats a lock whose holder is gone as stale", () => {
    assert.equal(STORE_LOCK_MTIME_UPDATE_MS, 1_000);
    assert.equal(STORE_LOCK_STALE_MS, 600_000);
    assert.equal(typeof tryAcquireStoreLock, "function");
    const lockError = new StoreLockError({ code: "stale", message: "held", lockPath: "/store/.lock" } as never);
    assert.equal(lockError instanceof Error, true);
  });
});

describe("the index a store keeps of itself", () => {
  it("records what the store holds, with deletion armed by a marker", () => {
    assert.equal(META_DELETION_ARMED, "deletion_armed");
    assert.equal(typeof LocalAgentStoreIndex, "function");
    assert.equal(typeof LocalIndexError, "function");
  });
});
