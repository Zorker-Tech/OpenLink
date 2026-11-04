import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT } from "../../source/host/extensions/content-search/agent-content-search.ts";
import { DB_BUSY_TIMEOUT_MS } from "../../source/host/storage/store-db.ts";
import {
  FTS_QUERY_MAX_TERMS,
  META_RECONCILE_DONE,
  SEARCH_INDEX_FILENAME,
  SEARCH_INDEX_SCHEMA_VERSION,
  buildFtsMatchQuery,
  ensureSearchIndexSchema,
  openSearchIndexDb,
  readReconcileDone,
  readSearchIndexSchemaVersion,
  searchMedia,
  searchMessages,
  stampSearchIndexSchemaVersion,
  writeReconcileDone,
  type AttachmentKind,
} from "../../source/host/extensions/content-search/search-index-db.ts";

function memoryIndex() {
  const db = openSearchIndexDb(":memory:");
  ensureSearchIndexSchema(db);
  return db;
}

function addMessage(db: ReturnType<typeof openSearchIndexDb>, row: {
  agentId: string;
  entryId: string;
  role?: "user" | "assistant";
  timestampMs: number;
  body: string;
}) {
  db.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body) VALUES (?, ?, ?, ?, ?)")
    .run(row.agentId, row.entryId, row.role ?? "user", row.timestampMs, row.body);
}

function addMedia(db: ReturnType<typeof openSearchIndexDb>, row: {
  agentId: string;
  entryId: string;
  fileName: string;
  ext: string;
  mime?: string | null;
  kind: string;
  timestampMs: number;
  width?: number | null;
  height?: number | null;
}) {
  db.prepare("INSERT INTO media (agent_id, entry_id, file_name, ext, mime, kind, timestamp_ms, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.agentId, row.entryId, row.fileName, row.ext, row.mime ?? null, row.kind, row.timestampMs, row.width ?? null, row.height ?? null);
}

describe("content search index database behavior contract", () => {
  it("keeps its own filename and versioned FTS query limits", () => {
    assert.equal(SEARCH_INDEX_FILENAME, "search-index.db");
    assert.equal(SEARCH_INDEX_SCHEMA_VERSION, 1);
    assert.equal(FTS_QUERY_MAX_TERMS, 8);
    assert.equal(META_RECONCILE_DONE, "reconcile_done");
  });

  it("normalizes query text, quotes each term, escapes quotes and caps the term count", () => {
    assert.equal(buildFtsMatchQuery("  Ａ\tB  "), '"A"* "B"*');
    assert.equal(buildFtsMatchQuery('a"b'), '"a""b"*');
    assert.equal(buildFtsMatchQuery("  \n\t "), null);
    assert.equal(buildFtsMatchQuery(Array.from({ length: FTS_QUERY_MAX_TERMS + 1 }, (_, i) => `t${i}`).join(" "))?.split(" ").length, FTS_QUERY_MAX_TERMS);
  });

  it("opens with the shared busy timeout and creates/stamps the schema version", () => {
    const db = memoryIndex();
    try {
      const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout?: unknown } | undefined;
      assert.equal(busy?.timeout, DB_BUSY_TIMEOUT_MS);
      assert.equal(readSearchIndexSchemaVersion(db), 0);
      stampSearchIndexSchemaVersion(db);
      assert.equal(readSearchIndexSchemaVersion(db), SEARCH_INDEX_SCHEMA_VERSION);
      db.exec("PRAGMA user_version = 7");
      assert.equal(readSearchIndexSchemaVersion(db), 7);
    } finally {
      db.close();
    }
  });

  it("stores reconcile completion idempotently and reads the metadata value", () => {
    const db = memoryIndex();
    try {
      assert.equal(readReconcileDone(db), false);
      writeReconcileDone(db);
      assert.equal(readReconcileDone(db), true);
      writeReconcileDone(db);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key = ?").get(META_RECONCILE_DONE)?.count, 1);
      db.prepare("UPDATE meta SET value = '0' WHERE key = ?").run(META_RECONCILE_DONE);
      assert.equal(readReconcileDone(db), false);
    } finally {
      db.close();
    }
  });

  it("searches FTS messages, normalizes snippets, and uses the agent's latest time for zero timestamps", () => {
    const db = memoryIndex();
    try {
      addMessage(db, { agentId: "a1", entryId: "zero-time", role: "user", timestampMs: 0, body: "  needle   in   haystack  " });
      addMessage(db, { agentId: "a1", entryId: "latest", role: "assistant", timestampMs: 1_500, body: "ordinary message" });
      const results = searchMessages(db, "Ｎｅｅｄｌｅ", 10);
      assert.deepEqual(results, [{
        agentId: "a1", entryId: "zero-time", role: "user", timestampMs: 1_500, snippet: "needle in haystack",
      }]);
    } finally {
      db.close();
    }
  });

  it("limits the matching messages per agent before applying the global recency limit", () => {
    const db = memoryIndex();
    try {
      for (let index = 0; index <= AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT; index += 1) {
        addMessage(db, { agentId: "many", entryId: `m-${index}`, timestampMs: 1_000 + index, body: "needle result" });
      }
      addMessage(db, { agentId: "other", entryId: "newest", timestampMs: 10_000, body: "needle result" });
      const results = searchMessages(db, "needle", AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT + 1);
      assert.equal(results.length, AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT + 1);
      assert.equal(results[0]?.entryId, "newest");
      assert.equal(results.some((result) => result.entryId === "m-0"), false);
      assert.equal(results.filter((result) => result.agentId === "many").length, AGENT_CONTENT_SEARCH_MAX_MATCHES_PER_AGENT);
    } finally {
      db.close();
    }
  });

  it("returns no message hits for blank queries, non-positive limits or unmatched terms", () => {
    const db = memoryIndex();
    try {
      addMessage(db, { agentId: "a1", entryId: "one", timestampMs: 1, body: "needle" });
      assert.deepEqual(searchMessages(db, " \n ", 10), []);
      assert.deepEqual(searchMessages(db, "needle", 0), []);
      assert.deepEqual(searchMessages(db, "missing", 10), []);
    } finally {
      db.close();
    }
  });

  it("searches media names and projects the supported metadata types", () => {
    const db = memoryIndex();
    try {
      addMedia(db, { agentId: "a1", entryId: "image", fileName: "needle-photo.png", ext: "png", mime: "image/png", kind: "image", timestampMs: 20, width: 640, height: 480 });
      addMedia(db, { agentId: "a2", entryId: "doc", fileName: "needle-notes.md", ext: "md", kind: "markdown", timestampMs: 10 });
      assert.deepEqual(searchMedia(db, "photo", 10), [{
        agentId: "a1", entryId: "image", fileName: "needle-photo.png", ext: "png", mime: "image/png",
        kind: "image", timestampMs: 20, width: 640, height: 480,
      }]);
      assert.equal(searchMedia(db, "needle", 1)[0]?.entryId, "image");
    } finally {
      db.close();
    }
  });

  it("lists recent media for a blank query and respects a non-positive limit", () => {
    const db = memoryIndex();
    try {
      addMedia(db, { agentId: "a1", entryId: "old", fileName: "old.txt", ext: "txt", kind: "text", timestampMs: 1 });
      addMedia(db, { agentId: "a2", entryId: "new", fileName: "new.txt", ext: "txt", kind: "text", timestampMs: 2 });
      assert.deepEqual(searchMedia(db, "  ", 10).map((row) => row.entryId), ["new", "old"]);
      assert.deepEqual(searchMedia(db, "text", 0), []);
    } finally {
      db.close();
    }
  });

  it("maps unknown attachment kinds to file and absent optional metadata to null", () => {
    const db = memoryIndex();
    try {
      addMedia(db, { agentId: "a1", entryId: "unknown", fileName: "mystery.bin", ext: "bin", kind: "future-kind", timestampMs: 3 });
      const row = searchMedia(db, "mystery", 10)[0];
      assert.deepEqual(row, {
        agentId: "a1", entryId: "unknown", fileName: "mystery.bin", ext: "bin", mime: null,
        kind: "file" satisfies AttachmentKind, timestampMs: 3, width: null, height: null,
      });
    } finally {
      db.close();
    }
  });
});
