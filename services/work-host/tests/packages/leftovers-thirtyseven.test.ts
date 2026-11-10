/**
 * The conflicts a sync finds: the journal they are recorded in and the pending one beside it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConflictJournal, conflictJournalPathForFilesDir, conflictPendingJournalPathForFilesDir, PendingConflictJournal } from "../../source/packages/agent-store-sync/conflict-events.ts";

describe("the conflicts a sync finds", () => {
  it("records them in a journal beside the files they are about", () => {
    // The journal lives beside the files, in the store's own sync directory.
    assert.equal(conflictJournalPathForFilesDir("/store/files"), "/store/.sync/conflict-events.jsonl");
    assert.equal(conflictPendingJournalPathForFilesDir("/store/files"), "/store/.sync/conflict-events.pending.jsonl");
    assert.equal(typeof ConflictJournal, "function");
    assert.equal(typeof PendingConflictJournal, "function");
  });
});
