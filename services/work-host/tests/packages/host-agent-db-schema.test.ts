import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  BRANCHED_ENTRY_FILTER_SQL,
  DIVIDER_ANCHOR_ENTRY_FILTER_SQL,
  MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL,
  SCHEMA,
  WINDOW_ENTRY_FILTER_SQL,
  prepareStatements,
  type PreparedStatement,
} from "../../source/host/extensions/session/agent-db-schema.ts";

/** An in-memory agent database, created from the schema the extension ships. */
function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

/** The two filters a window read is built from. */
function statements(db: DatabaseSync): Record<string, PreparedStatement> {
  return prepareStatements({
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        all: (...parameters: unknown[]) => statement.all(...(parameters as never[])),
        get: (...parameters: unknown[]) => statement.get(...(parameters as never[])),
        run: (...parameters: unknown[]) => statement.run(...(parameters as never[])),
      };
    },
  });
}

const entry = (kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ kind, timestampMs: 1, ...extra });

describe("creating an agent's database", () => {
  it("makes the three tables and both indexes, and can be run twice", () => {
    const db = database();
    db.exec(SCHEMA);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, ["blobs", "kv", "transcript_entries"]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all().map((row) => (row as { name: string }).name);
    assert.deepEqual(indexes, ["idx_transcript_branched", "idx_transcript_window"]);
    // Each index is built for the filter it serves: the window one leaves tool calls out.
    const definitions = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{ name: string; sql: string }>;
    const windowIndex = definitions.find((row) => row.name === "idx_transcript_window")?.sql ?? "";
    assert.match(windowIndex, /tool-call/);
    assert.match(windowIndex, /branched/);
    db.close();
  });

  it("keeps the key-value store to one value per key", () => {
    const db = database();
    const statementsForDb = statements(db);
    statementsForDb["setKv"]!.run("k", "first");
    statementsForDb["setKv"]!.run("k", "second");
    assert.deepEqual({ ...(statementsForDb["getKv"]!.get("k") as object) }, { value: "second" });
    assert.equal((statementsForDb["compareAndSetKv"]!.run("third", "k", "second") as { changes: number }).changes, 1);
    assert.equal((statementsForDb["compareAndSetKv"]!.run("fourth", "k", "first") as { changes: number }).changes, 0);
    assert.deepEqual({ ...(statementsForDb["getKv"]!.get("k") as object) }, { value: "third" });
    statementsForDb["deleteKv"]!.run("k");
    assert.equal(statementsForDb["getKv"]!.get("k"), undefined);
    db.close();
  });

  it("keeps one entry per id, and ignores a second one", () => {
    const db = database();
    const statementsForDb = statements(db);
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("message"));
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("message", { other: true }));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM transcript_entries").get() as { count: number }).count, 1);
    // The first write is the one that stands: a second insert of the same id is ignored, not applied.
    const kept = statementsForDb["getTranscriptEntry"]!.get("m1") as { entry: string };
    assert.match(kept.entry, /message/);
    assert.equal(kept.entry.includes("other"), false);
    db.close();
  });
});

describe("reading a window of a transcript", () => {
  it("leaves tool calls and branched entries out of the window", () => {
    const db = database();
    const statementsForDb = statements(db);
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("message"));
    statementsForDb["insertTranscriptEntry"]!.run("t1", entry("tool-call"));
    statementsForDb["insertTranscriptEntry"]!.run("b1", entry("message", { branched: 1 }));
    statementsForDb["insertTranscriptEntry"]!.run("u1", entry("send-message"));
    const window = statementsForDb["listTranscriptWindow"]!.all(null, null, 10).map((row) => (row as { entry: string }).entry);
    assert.equal(window.length, 2);
    assert.match(WINDOW_ENTRY_FILTER_SQL, /tool-call/);
    assert.match(WINDOW_ENTRY_FILTER_SQL, /branched/);
    db.close();
  });

  it("keeps the page to the messages a transcript shows, and to the window it was asked for", () => {
    const db = database();
    const statementsForDb = statements(db);
    const page = (seqBefore: number | null, from: number | null, to: number | null) =>
      statementsForDb["listTranscriptPage"]!.all(seqBefore, seqBefore, from, from, to, 10).map((row) => (row as { entry: string }).entry);
    statementsForDb["insertTranscriptEntry"]!.run("s1", entry("send-message", { timestampMs: 100 }));
    statementsForDb["insertTranscriptEntry"]!.run("u1", entry("message", { role: "user", timestampMs: 101 }));
    statementsForDb["insertTranscriptEntry"]!.run("a1", entry("message", { role: "assistant", timestampMs: 102 }));
    statementsForDb["insertTranscriptEntry"]!.run("from-agent", entry("message", { role: "assistant", fromAgent: "a1", timestampMs: 103 }));
    statementsForDb["insertTranscriptEntry"]!.run("s2", entry("send-message", { timestampMs: 150 }));
    statementsForDb["insertTranscriptEntry"]!.run("t1", entry("tool-call", { timestampMs: 104 }));
    statementsForDb["insertTranscriptEntry"]!.run("sys", entry("message", { role: "system", timestampMs: 105 }));
    // The upper bound is not optional: a page asked for "up to nothing" is a page of nothing.
    assert.equal(page(null, null, null).length, 0);
    const everything = page(null, null, 1_000);
    // A page shows the sends, the user's own messages, and anything a message between agents carries.
    assert.equal(everything.length, 4);
    assert.equal(everything.some((line) => line.includes("\"role\":\"user\"")), true);
    assert.equal(everything.some((line) => line.includes("fromAgent")), true);
    assert.equal(everything.some((line) => line.includes("assistant\"},")), false, "an assistant message that came from nobody is not a page line of its own");
    assert.equal(everything.some((line) => line.includes("tool-call")), false);
    const bounded = page(null, 100, 120);
    assert.equal(bounded.length, 3, "the newest send is past the window it was asked for");
    db.close();
  });

  it("reads only branched entries through the branch filter, in order", () => {
    const db = database();
    const statementsForDb = statements(db);
    statementsForDb["insertTranscriptEntry"]!.run("b1", entry("message", { branched: 1 }));
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("message"));
    statementsForDb["insertTranscriptEntry"]!.run("b2", entry("message", { branched: 1 }));
    const branched = statementsForDb["listBranchedEntries"]!.all();
    assert.equal(branched.length, 2);
    assert.match(BRANCHED_ENTRY_FILTER_SQL, /branched/);
    db.close();
  });

  it("pages by sequence and by timestamp, before or up to the ones it was given", () => {
    const db = database();
    const statementsForDb = statements(db);
    for (let index = 0; index < 5; index += 1) statementsForDb["insertTranscriptEntry"]!.run(`m${index}`, entry("send-message", { timestampMs: 100 + index }));
    const page = statementsForDb["listTranscriptPage"]!.all(3, 3, 101, 101, 103, 10).map((row) => (row as { entry: string }).entry);
    // Sequences are one per insert: m0 is 1 and m1 is 2, so only m1 is below three and inside the window.
    assert.equal(page.length, 1);
    db.close();
  });

  it("answers the newest divider anchor among the messages the filter admits", () => {
    const db = database();
    const statementsForDb = statements(db);
    // An anchor is a message that came from or went to an agent, or a send: a plain user message is not one.
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("send-message", { timestampMs: 10 }));
    statementsForDb["insertTranscriptEntry"]!.run("m0", entry("message", { role: "user", timestampMs: 5 }));
    statementsForDb["insertTranscriptEntry"]!.run("m2", entry("message", { role: "assistant", timestampMs: 20 }));
    statementsForDb["insertTranscriptEntry"]!.run("m3", entry("tool-call", { timestampMs: 30 }));
    statementsForDb["insertTranscriptEntry"]!.run("m4", entry("send-message", { timestampMs: 40 }));
    // Newer, but a plain user message is not an anchor: the divider filter is what keeps it out.
    statementsForDb["insertTranscriptEntry"]!.run("m5", entry("message", { role: "user", timestampMs: 50 }));
    const anchor = statementsForDb["newestDividerAnchorTimestamp"]!.get();
    assert.deepEqual({ ...(anchor as object) }, { timestampMs: 40 }, "a plain user message, an assistant message and a tool call are not anchors");
    assert.match(DIVIDER_ANCHOR_ENTRY_FILTER_SQL, /send-message/);
    // It is the newest anchor, not the first one the scan meets.
    assert.equal((statementsForDb["newestDividerAnchorTimestamp"]!.all() as unknown[]).length, 1);
    assert.match(MAIN_TRANSCRIPT_MESSAGE_FILTER_SQL, /fromAgent/);
    db.close();
  });

  it("reads the tail without the window's exclusions", () => {
    const db = database();
    const statementsForDb = statements(db);
    statementsForDb["insertTranscriptEntry"]!.run("m1", entry("message"));
    statementsForDb["insertTranscriptEntry"]!.run("t1", entry("tool-call"));
    const tail = statementsForDb["listTranscriptTail"]!.all(null, null, 10);
    assert.equal(tail.length, 2, "a tail is everything the transcript holds");
    db.close();
  });
});

describe("the statements a caller gets", () => {
  it("hands back one prepared statement per name the database is used through", () => {
    const names = Object.keys(statements(database()));
    assert.deepEqual(names, [
      "getKv",
      "setKv",
      "compareAndSetKv",
      "deleteKv",
      "hasLegacyBlob",
      "clearBlobs",
      "listTranscriptEntries",
      "newestDividerAnchorTimestamp",
      "listTranscriptPage",
      "listTranscriptWindow",
      "listTranscriptTail",
      "listBranchedEntries",
      "getTranscriptEntry",
      "insertTranscriptEntry",
      "updateTranscriptEntry",
      "deleteTranscriptEntry",
      "clearTranscriptEntries",
    ]);
  });
});
