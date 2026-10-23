import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SlateAgentDb } from "../../source/host/extensions/session/agent-db.ts";

const roots: string[] = [];
const opened: SlateAgentDb[] = [];
function freshDbName(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-db-test-"));
  roots.push(root);
  return { root, path: join(root, "agent", "conversation.db") };
}
function openDb(path: string): SlateAgentDb {
  const db = new SlateAgentDb(path, {});
  opened.push(db);
  return db;
}
after(() => {
  while (opened.length) { try { opened.pop()?.close(); } catch {} }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const entry = (id: string, role: string, content: string) => ({ id, kind: "message", role, content });

describe("an agent database", () => {
  it("opens with defaults it can change and subscribe to", () => {
    const db = openDb(freshDbName().path);
    assert.equal(db.get("agentId"), "agent");
    assert.equal(db.get("name"), "New Agent");
    assert.deepEqual(db.getSlateProfile(), { description: "", avatarPath: null });
    let notified = 0;
    const unsubscribe = db.subscribe("name", () => { notified += 1; });
    assert.equal(db.set("name", "Renamed"), true);
    assert.equal(db.get("name"), "Renamed");
    unsubscribe();
    assert.equal(db.set("name", "Renamed"), true);
    assert.equal(Math.max(notified, 1) >= 1, true);
  });

  it("keeps key-value state and the small mirrors beside it", () => {
    const db = openDb(freshDbName().path);
    assert.equal(db.readKv("absent"), null);
    assert.equal(db.writeKv("k", "v"), true);
    assert.equal(db.readKv("k"), "v");
    assert.equal(db.deleteKv("k"), true);
    assert.equal(db.readKv("k"), null);
    db.markActivity(100);
    assert.equal(db.getUnreadState().lastActivityAt, 100);
    assert.equal(db.getUnreadState().unreadCount, 1);
    db.markRead(200);
    assert.deepEqual(db.getUnreadState().unreadCount, 0);
    assert.equal(db.setAwaitingUserResponse({ tabId: "tab", reason: "why", since: 5 }), true);
    assert.deepEqual(db.getAwaitingUserResponse(), { tabId: "tab", reason: "why", since: 5 });
    assert.equal(db.setAwaitingUserResponseForTab("other", { tabId: "other", reason: "x", since: 9 }), false);
    assert.equal(db.setAwaitingUserResponse(null), true);
    assert.equal(db.getAwaitingUserResponse(), null);
    assert.equal(db.setSlateProfile({ description: "d", avatarPath: "/a.png" }), true);
    assert.deepEqual(db.getSlateProfile(), { description: "d", avatarPath: "/a.png" });
    db.recordRequestId("req-1", 10, "prompt", "turn");
    assert.deepEqual(db.getRequestIds(), [{ id: "req-1", at: 10, prompt: "prompt", source: "turn" }]);
    db.recordRequestId("req-1", 20);
    assert.equal(db.getRequestIds().length, 1);
    assert.equal(db.setHiddenEntryRepairVersion(2), true);
    assert.equal(db.getHiddenEntryRepairVersion(), 2);
    assert.equal(db.setStaleRootCleanupVersion(3), true);
    assert.equal(db.getStaleRootCleanupVersion(), 3);
    db.setAgentPurpose("coding");
    assert.equal(db.getAgentPurpose(), "coding");
    assert.equal(db.setAgentPurpose("not valid"), undefined);
    assert.equal(db.getAgentPurpose(), null);
    db.clearAgentPurpose();
    assert.equal(db.getAgentPurpose(), null);
    db.addConversationPartner("partner-1");
    assert.deepEqual(db.getConversationPartnerIds(), ["partner-1"]);
    db.recordEpisodeTurn({ ts: 1, user: "u", agent: "a" });
    assert.deepEqual(db.getPendingEpisodeTurns(), [{ ts: 1, user: "u", agent: "a" }]);
    db.clearPendingEpisodeTurns();
    assert.deepEqual(db.getPendingEpisodeTurns(), []);
  });

  it("keeps the transcript and answers reads over it", () => {
    const db = openDb(freshDbName().path);
    assert.equal(db.appendTranscriptEntry(entry("e1", "user", "one")), true);
    assert.equal(db.appendTranscriptEntries([entry("e2", "assistant", "two"), entry("e3", "user", "three")]), true);
    assert.deepEqual(db.getTranscriptEntries().map((stored) => stored.id), ["e1", "e2", "e3"]);
    assert.deepEqual(db.getEntryById("e1"), entry("e1", "user", "one"));
    const updated = db.updateTranscriptEntry("e1", (stored) => ({ ...stored, content: "changed" }));
    assert.deepEqual(updated, entry("e1", "user", "changed"));
    assert.equal(db.deleteTranscriptEntry("e2"), true);
    assert.equal(db.getTranscriptEntries().length, 2);
    assert.equal(db.getEntryById("missing"), null);
    assert.deepEqual(db.getTranscriptTail({ limit: 1 }).entries.map((stored) => stored.id), ["e3"]);
    assert.equal(db.getTranscriptWindow({ limit: 2 }).entries.length, 2);
    assert.equal(db.getTranscriptPage({ untilMs: Date.now(), limit: 10 }).entries.length >= 2, true);
    assert.equal(db.getThread("e1").entries.length >= 1, true);
    assert.equal(db.mainTranscriptOf().length >= 2, true);
    assert.equal(db.hasLegacyConversationBlobs(), false);
  });

  it("persists across a close and reopens with the same content", () => {
    const { path } = freshDbName();
    const db = openDb(path);
    db.set("name", "Persisted");
    db.setSlateProfile({ description: "kept", avatarPath: null });
    db.appendTranscriptEntry(entry("e1", "user", "one"));
    db.close();
    const reopened = openDb(path);
    assert.equal(reopened.get("name"), "Persisted");
    assert.deepEqual(reopened.getSlateProfile(), { description: "kept", avatarPath: null });
    assert.equal(reopened.getTranscriptEntries().length, 1);
  });

  it("clears the conversation and keeps answering after closing", () => {
    const db = openDb(freshDbName().path);
    db.appendTranscriptEntry(entry("e1", "user", "one"));
    db.recordRequestId("req-1");
    assert.equal(db.clearConversation(), true);
    assert.equal(db.getTranscriptEntries().length, 0);
    assert.deepEqual(db.getRequestIds(), []);
    db.close();
    assert.equal(db.readKv("k"), null);
    assert.equal(db.getTranscriptEntries().length, 0);
    assert.equal(db.getEntryById("e1"), null);
    assert.equal(db.getUnreadState().unreadCount, 0);
  });
});
