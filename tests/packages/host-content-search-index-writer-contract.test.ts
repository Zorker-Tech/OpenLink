import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ensureSearchIndexSchema, readReconcileDone, searchMedia, searchMessages } from "../../source/host/extensions/content-search/search-index-db.ts";
import { INCREMENTAL_VACUUM_PAGES, SlateSearchIndexWriter, STORE_FILENAME, type IndexEntry } from "../../source/host/extensions/content-search/search-index-writer.ts";

interface WriterWorld {
  index: DatabaseSync;
  agentsRoot: string;
  writer: SlateSearchIndexWriter;
  dispose(): void;
}

function world(): WriterWorld {
  const root = mkdtempSync(join(tmpdir(), "slate-search-writer-"));
  const agentsRoot = join(root, "agents");
  mkdirSync(agentsRoot, { recursive: true });
  const index = new DatabaseSync(":memory:");
  ensureSearchIndexSchema(index);
  const writer = new SlateSearchIndexWriter(index, agentsRoot);
  return {
    index,
    agentsRoot,
    writer,
    dispose() {
      writer.close();
      index.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function transcriptDb(agentsRoot: string, agentId: string, entries: readonly { seq: number; entry: unknown }[]): void {
  const agentDir = join(agentsRoot, agentId);
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(join(agentDir, STORE_FILENAME));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS transcript_entries (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL)");
    db.exec("DELETE FROM transcript_entries");
    const insert = db.prepare("INSERT INTO transcript_entries (seq, entry) VALUES (?, ?)");
    for (const row of entries) insert.run(row.seq, typeof row.entry === "string" ? row.entry : JSON.stringify(row.entry));
  } finally {
    db.close();
  }
}

function messageRows(db: DatabaseSync, agentId: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT agent_id AS agentId, entry_id AS entryId, role, timestamp_ms AS timestampMs, body FROM messages WHERE agent_id = ? ORDER BY entry_id").all(agentId) as Array<Record<string, unknown>>).map(row => ({ ...row }));
}

function mediaRows(db: DatabaseSync, agentId: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT agent_id AS agentId, entry_id AS entryId, file_name AS fileName, ext, mime, kind, timestamp_ms AS timestampMs, width, height FROM media WHERE agent_id = ? ORDER BY entry_id").all(agentId) as Array<Record<string, unknown>>).map(row => ({ ...row }));
}

describe("content search index writer contract", () => {
  it("uses the transcript store filename and the bounded incremental vacuum size", () => {
    assert.equal(STORE_FILENAME, "store.db");
    assert.equal(INCREMENTAL_VACUUM_PAGES, 512);
  });

  it("indexes messages, text send-messages, and notices while rejecting private routed messages", t => {
    const h = world();
    t.after(() => h.dispose());
    const entries: IndexEntry[] = [
      { id: "user", kind: "message", role: "user", timestampMs: 10.6, content: "  find the lighthouse  " },
      { id: "default-role", kind: "message", timestampMs: Number.NaN, content: "assistant fallback" },
      { id: "to-agent", kind: "message", toAgent: { kind: "agent" }, content: "keep routed agent text" },
      { id: "to-tool", kind: "message", toAgent: { kind: "tool" }, content: "private tool text" },
      { id: "sent-text", kind: "send-message", timestampMs: -1.4, message: { type: "text", content: "  sent words  " } },
      { id: "sent-attachment", kind: "send-message", message: { type: "attachment", content: "not message text", url: "/docs/a.pdf" } },
      { id: "notice", kind: "notice", text: "  routine notice  " },
    ];
    h.writer.runJob({ kind: "upsert-entries", agentId: "agent-a", entries });
    assert.deepEqual(messageRows(h.index, "agent-a"), [
      { agentId: "agent-a", entryId: "default-role", role: "assistant", timestampMs: 0, body: "assistant fallback" },
      { agentId: "agent-a", entryId: "notice", role: "assistant", timestampMs: 0, body: "routine notice" },
      { agentId: "agent-a", entryId: "sent-text", role: "assistant", timestampMs: -1, body: "sent words" },
      { agentId: "agent-a", entryId: "to-agent", role: "assistant", timestampMs: 0, body: "keep routed agent text" },
      { agentId: "agent-a", entryId: "user", role: "user", timestampMs: 11, body: "find the lighthouse" },
    ]);
    assert.deepEqual(searchMessages(h.index, "lighthouse", 5).map(result => result.entryId), ["user"]);
  });

  it("caps indexed message bodies and skips blank or non-text entries", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [
      { id: "large", kind: "message", content: `  ${"x".repeat(20_010)}  ` },
      { id: "blank", kind: "notice", text: "  \n " },
      { id: "image", kind: "message", content: "", message: { type: "text", content: "not a message body" } },
      { id: "unknown", kind: "other", content: "not indexed" },
    ]);
    const rows = messageRows(h.index, "agent-a");
    assert.equal(rows.length, 1);
    assert.equal((rows[0]?.body as string).length, 20_000);
    assert.equal((rows[0]?.body as string).startsWith("x"), true);
  });

  it("indexes attachment metadata with a decoded path fallback and rounded dimensions", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [
      { id: "photo", kind: "user-attachment", file_path: "https://files.example/a/photo%20one.PNG", file_name: "  ", timestampMs: 4.8, width: 10.6, height: 2.2 },
      { id: "pdf", kind: "send-message", timestampMs: 8, message: { type: "attachment", url: "/files/annual.pdf" } },
    ]);
    const rows = mediaRows(h.index, "agent-a");
    assert.deepEqual(rows, [
      { agentId: "agent-a", entryId: "pdf", fileName: "annual.pdf", ext: ".pdf", mime: null, kind: "pdf", timestampMs: 8, width: null, height: null },
      { agentId: "agent-a", entryId: "photo", fileName: "photo one.PNG", ext: ".png", mime: "image/png", kind: "image", timestampMs: 5, width: 11, height: 2 },
    ]);
    assert.deepEqual(searchMedia(h.index, "annual", 5).map(result => result.entryId), ["pdf"]);
  });

  it("uses an explicit attachment name and rejects a message with no usable media path", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [
      { id: "named", kind: "user-attachment", file_path: "/tmp/data", file_name: " Report.CSV ", width: Infinity, height: "3" as never },
      { id: "bad", kind: "send-message", message: { type: "attachment", url: "" } },
    ]);
    assert.deepEqual(mediaRows(h.index, "agent-a"), [
      { agentId: "agent-a", entryId: "named", fileName: "Report.CSV", ext: ".csv", mime: null, kind: "table", timestampMs: 0, width: null, height: null },
    ]);
  });

  it("deletes an old message or media row when a replacement no longer qualifies", t => {
    const h = world();
    try {
      h.writer.upsertEntries("agent-a", [
        { id: "entry", kind: "message", content: "findable" },
        { id: "asset", kind: "user-attachment", file_path: "/tmp/photo.png" },
      ]);
      h.writer.upsertEntries("agent-a", [
        { id: "entry", kind: "message", content: "   " },
        { id: "asset", kind: "other", content: "not media" },
      ]);
      assert.deepEqual(messageRows(h.index, "agent-a"), []);
      assert.deepEqual(mediaRows(h.index, "agent-a"), []);
      assert.deepEqual(searchMessages(h.index, "findable", 5), []);
    } finally {
      h.dispose();
    }
  });

  it("does nothing for an empty upsert and removes only the requested entry", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [
      { id: "one", kind: "message", content: "one" },
      { id: "two", kind: "message", content: "two" },
    ]);
    const before = messageRows(h.index, "agent-a");
    h.writer.runJob({ kind: "upsert-entries", agentId: "agent-a", entries: [] });
    assert.deepEqual(messageRows(h.index, "agent-a"), before);
    h.writer.runJob({ kind: "delete-entry", agentId: "agent-a", entryId: "one" });
    assert.deepEqual(messageRows(h.index, "agent-a").map(row => row.entryId), ["two"]);
  });

  it("reindexes valid transcript rows and fingerprints the row count and greatest sequence", t => {
    const h = world();
    t.after(() => h.dispose());
    transcriptDb(h.agentsRoot, "agent-a", [
      { seq: 2, entry: { id: "m1", kind: "message", role: "user", content: "reindexed lighthouse" } },
      { seq: 9, entry: "{broken" },
      { seq: 11, entry: { id: "m2", kind: "notice", text: "valid after broken" } },
    ]);
    h.writer.runJob({ kind: "reindex-agents", agentIds: ["agent-a"] });
    assert.deepEqual(messageRows(h.index, "agent-a").map(row => row.entryId), ["m1", "m2"]);
    assert.deepEqual({ ...(h.index.prepare("SELECT fingerprint FROM agents WHERE agent_id = ?").get("agent-a") as Record<string, unknown>) }, { fingerprint: "3:11" });
    assert.deepEqual(searchMessages(h.index, "lighthouse", 5).map(result => result.entryId), ["m1"]);
  });

  it("clears an index row set when its transcript database is missing", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [{ id: "old", kind: "message", content: "old text" }]);
    h.writer.reindexAgent("agent-a");
    assert.deepEqual(messageRows(h.index, "agent-a"), []);
    assert.equal(h.index.prepare("SELECT fingerprint FROM agents WHERE agent_id = ?").get("agent-a"), undefined);
  });

  it("reconciles removed agents, changed fingerprints, and marks reconciliation complete", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("gone-agent", [{ id: "old", kind: "message", content: "remove me" }]);
    transcriptDb(h.agentsRoot, "live-agent", [{ seq: 1, entry: { id: "initial", kind: "message", content: "old words" } }]);
    h.writer.reindexAgent("live-agent");
    h.writer.close();
    transcriptDb(h.agentsRoot, "live-agent", [
      { seq: 1, entry: { id: "initial", kind: "message", content: "old words" } },
      { seq: 3, entry: { id: "new", kind: "message", content: "new beacon" } },
    ]);
    h.writer.reconcile();
    assert.deepEqual(messageRows(h.index, "gone-agent"), []);
    assert.deepEqual(messageRows(h.index, "live-agent").map(row => row.entryId), ["initial", "new"]);
    assert.equal(readReconcileDone(h.index), true);
  });

  it("clears the agent's messages, media, and fingerprint together", t => {
    const h = world();
    t.after(() => h.dispose());
    h.writer.upsertEntries("agent-a", [
      { id: "message", kind: "message", content: "clear me" },
      { id: "asset", kind: "user-attachment", file_path: "/tmp/image.jpg" },
    ]);
    h.writer.runJob({ kind: "clear-agent", agentId: "agent-a" });
    assert.deepEqual(messageRows(h.index, "agent-a"), []);
    assert.deepEqual(mediaRows(h.index, "agent-a"), []);
    assert.equal(h.index.prepare("SELECT fingerprint FROM agents WHERE agent_id = ?").get("agent-a"), undefined);
  });

  it("closes cached transcript databases and remains safe to close twice", t => {
    const h = world();
    t.after(() => h.dispose());
    transcriptDb(h.agentsRoot, "agent-a", [{ seq: 1, entry: { id: "m1", kind: "message", content: "hello" } }]);
    h.writer.reindexAgent("agent-a");
    h.writer.close();
    h.writer.close();
    assert.deepEqual(messageRows(h.index, "agent-a").map(row => row.entryId), ["m1"]);
  });
});
