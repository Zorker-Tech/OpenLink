import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expirePendingAutoReviewApprovalEntries,
  expirePendingLocalToolPermissionAskEntries,
} from "../../source/host/extensions/session/pending-card-sweeps.ts";

function database(entries: Array<Record<string, unknown>>) {
  const updated: Array<{ id: string; entry: Record<string, unknown> }> = [];
  return {
    updated,
    db: {
      getTranscriptEntries: () => entries,
      updateTranscriptEntry: (id: string, update: (entry: Record<string, unknown>) => Record<string, unknown>) => {
        const original = entries.find((entry) => entry.id === id) ?? {};
        updated.push({ id, entry: update(original) });
      },
    },
  };
}

test("auto-review sweeps settle only pending approval cards and honor an optional request id", () => {
  const world = database([
    { id: "a", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r1", status: "pending" } } },
    { id: "b", kind: "send-message", message: { type: "auto-review-approval", approval: { requestId: "r2", status: "approved" } } },
    { id: "c", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r3", status: "pending" } } },
  ]);
  assert.deepEqual(expirePendingAutoReviewApprovalEntries(world.db), ["r1"]);
  assert.equal(world.updated.length, 1);
  assert.equal((world.updated[0]?.entry.message as { approval?: { status?: string } }).approval?.status, "expired");
  assert.deepEqual(expirePendingAutoReviewApprovalEntries(world.db, "missing"), []);
});

test("permission-card age cutoff excludes the boundary and newer entries, but allows missing timestamps", () => {
  const world = database([
    { id: "old", kind: "send-message", timestampMs: 49, message: { type: "local-tool-permission", ask: { requestId: "r1", status: "pending" } } },
    { id: "boundary", kind: "send-message", timestampMs: 50, message: { type: "local-tool-permission", ask: { requestId: "r2", status: "pending" } } },
    { id: "new", kind: "send-message", timestampMs: 51, message: { type: "local-tool-permission", ask: { requestId: "r3", status: "pending" } } },
    { id: "unknown-time", kind: "send-message", message: { type: "local-tool-permission", ask: { requestId: "r4", status: "pending" } } },
  ]);
  assert.deepEqual(expirePendingLocalToolPermissionAskEntries(world.db, { ifPendingBeforeMs: 50 }), ["r1", "r4"]);
  assert.deepEqual(world.updated.map(({ id }) => id), ["old", "unknown-time"]);
});
