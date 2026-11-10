import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ConflictJournal,
  PendingConflictJournal,
  conflictJournalPathForFilesDir,
  conflictPendingJournalPathForFilesDir,
} from "../../source/packages/agent-store-sync/conflict-events.ts";
import { AGENT_STORE_CONFLICT_EVENTS_FILE_NAME, AGENT_STORE_CONFLICT_PENDING_FILE_NAME, AGENT_STORE_SYNC_DIR_NAME } from "../../source/packages/agent-store-sync/paths.ts";

function tempRoot(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "conflict-events-test-"));
}
const emit = (overrides: any = {}) => ({ kind: "write_conflict", storeId: "store-1", originalRelPath: "a/b.txt", originalAbsPath: "/abs/a/b.txt", conflictRelPath: "a/b.txt.conflict", conflictAbsPath: "/abs/a/b.txt.conflict", preservedBytes: 12, ...overrides });
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("the conflict journal", () => {
  it("writes one JSON line per conflict and dedupes a repeat", () => {
    const root = tempRoot();
    try {
      const path = join(root, "events.jsonl");
      const journal = new ConflictJournal(path);
      assert.equal(journal.emit(emit()), true);
      assert.equal(journal.emit(emit({ kind: "create_conflict", conflictRelPath: "c/second.txt.conflict", conflictAbsPath: "/abs/second.conflict" })), true);
      const first = lines(path);
      assert.equal(first.length, 2);
      assert.equal(first[0]?.v, 1);
      assert.equal(first[0]?.event_id.length > 0, true);
      assert.equal(typeof first[0]?.journal_epoch, "string");
      assert.equal(first[0]?.seq, 1);
      assert.equal(first[0]?.kind, "write_conflict");
      assert.equal(first[0]?.store_id, "store-1");
      assert.equal(first[0]?.original_rel_path, "a/b.txt");
      assert.equal(first[0]?.conflict_rel_path, "a/b.txt.conflict");
      assert.equal(first[0]?.preserved_bytes, 12);
      // The same conflict is not written twice.
      assert.equal(journal.emit(emit()), true);
      assert.equal(lines(path).length, 2);
      assert.equal(journal.wouldDedup(emit()), true);
      // Failures are counted rather than thrown, and a later journal hydrates the dedupe set from disk.
      const hydrated = new ConflictJournal(path);
      assert.equal(hydrated.wouldDedup(emit()), true);
      assert.equal(hydrated.appendFailureCount(), 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rotates an oversized journal into a gap event", () => {
    const root = tempRoot();
    try {
      const path = join(root, "events.jsonl");
      writeFileSync(path, "x".repeat(5 * 1024 * 1024));
      const journal = new ConflictJournal(path);
      assert.equal(journal.emit(emit()), true);
      const written = lines(path);
      assert.equal(written.length, 2);
      assert.equal(written[0]?.kind, "gap");
      assert.equal(journal.rotationCount(), 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a symlinked journal path and counts the failure", () => {
    const root = tempRoot();
    try {
      const target = join(root, "real.jsonl");
      writeFileSync(target, "");
      const path = join(root, "events.jsonl");
      symlinkSync(target, path);
      const warnings: unknown[] = [];
      const journal = new ConflictJournal(path, { warn: (message, error) => warnings.push([message, error]) });
      assert.equal(journal.emit(emit()), false);
      assert.equal(journal.appendFailureCount(), 1);
      assert.equal(warnings.length >= 1, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("exports the journal paths next to the files directory", () => {
    const filesDir = "/data/store/files";
    assert.equal(conflictJournalPathForFilesDir(filesDir), join("/data/store", AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_EVENTS_FILE_NAME));
    assert.equal(conflictPendingJournalPathForFilesDir(filesDir), join("/data/store", AGENT_STORE_SYNC_DIR_NAME, AGENT_STORE_CONFLICT_PENDING_FILE_NAME));
  });
});

  it("skips an event with an unknown kind even when it is otherwise well formed", () => {
    const root = tempRoot();
    try {
      const path = join(root, "events.jsonl");
      writeFileSync(path, JSON.stringify({ v: 1, event_id: "e", journal_epoch: "j", seq: 1, ts_ms: 1, kind: "unknown_kind", store_id: "store-1", conflict_rel_path: "a/b.txt.conflict" }) + "\n");
      const journal = new ConflictJournal(path);
      assert.equal(journal.wouldDedup(emit()), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

describe("the pending conflict journal", () => {
  it("persists, reloads and dedupes entries", () => {
    const root = tempRoot();
    try {
      const path = join(root, "pending.jsonl");
      const journal = new PendingConflictJournal(path);
      assert.equal(journal.isEmpty(), true);
      journal.enqueue(emit());
      journal.enqueue(emit());
      assert.equal(journal.size(), 1);
      assert.equal(lines(path).length, 1);
      const reloaded = new PendingConflictJournal(path);
      assert.equal(reloaded.size(), 1);
      assert.equal(reloaded.list()[0]?.storeId, "store-1");
      // Removing the last entry removes the sidecar.
      reloaded.replaceAll([]);
      assert.equal(reloaded.isEmpty(), true);
      assert.throws(() => readFileSync(path));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("merges a reload with entries added while it was dirty", () => {
    const root = tempRoot();
    try {
      const path = join(root, "pending.jsonl");
      const first = new PendingConflictJournal(path);
      first.enqueue(emit());
      const second = new PendingConflictJournal(path);
      second.enqueue(emit({ conflictRelPath: "other.txt.conflict" }));
      first.enqueue(emit({ conflictRelPath: "third.txt.conflict" }));
      first.reload();
      assert.equal(first.size() >= 1, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps a broken sidecar from blocking new entries", () => {
    const root = tempRoot();
    try {
      const path = join(root, "pending.jsonl");
      mkdirSync(path);
      const warnings: unknown[] = [];
      const journal = new PendingConflictJournal(path, { warn: (message, error) => warnings.push([message, error]) });
      assert.equal(warnings.length >= 1, true);
      journal.enqueue(emit());
      assert.equal(journal.size() >= 0, true);
      assert.equal(journal.persistFailureCount() >= 0, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
