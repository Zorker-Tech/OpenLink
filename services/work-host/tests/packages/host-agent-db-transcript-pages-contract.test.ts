import assert from "node:assert/strict"
import { test } from "node:test"

import {
  loadAgentTranscriptPage,
  loadAgentTranscriptTail,
  loadAgentTranscriptWindow,
  type AgentTranscriptSqlStatements,
} from "../../source/host/extensions/session/agent-db-transcript-pages.ts"

function row(seq: number, entry: unknown) {
  return { seq, entry: typeof entry === "string" ? entry : JSON.stringify(entry) }
}

function statementHarness(options: {
  pageRows?: Array<{ seq: number; entry: string }>
  windowRows?: Array<{ seq: number; entry: string }>
  tailRows?: Array<{ seq: number; entry: string }>
}) {
  const calls: unknown[][] = []
  const statements: AgentTranscriptSqlStatements = {
    listTranscriptPage: { all: (...args) => (calls.push(["page", ...args]), options.pageRows ?? []) },
    listTranscriptWindow: { all: (...args) => (calls.push(["window", ...args]), options.windowRows ?? []) },
    listTranscriptTail: { all: (...args) => (calls.push(["tail", ...args]), options.tailRows ?? []) },
  }
  return { statements, calls }
}

test("a page reads one extra descending row, returns valid entries oldest-first, and continues from the oldest row", () => {
  const store = statementHarness({ pageRows: [
    row(8, { kind: "message", id: "newer", content: "new" }),
    row(7, "invalid-json"),
    row(6, { kind: "message", id: "older", content: "old" }),
  ] })

  assert.deepEqual(loadAgentTranscriptPage(store.statements, { beforeSeq: 9, sinceMs: 0, untilMs: 100, limit: 2 }), {
    entries: [{ kind: "message", id: "newer", content: "new" }],
    nextBeforeSeq: 7,
  })
  assert.deepEqual(store.calls, [["page", 9, 9, 0, 0, 100, 3]])
})

test("a transcript window normalizes its cursor and caps its requested size before counting threads", () => {
  const store = statementHarness({ windowRows: [
    row(3, { kind: "message", id: "a", content: "a" }),
    row(2, { kind: "message", id: "b", content: "b" }),
  ] })
  const counts: unknown[][] = []

  assert.deepEqual(loadAgentTranscriptWindow(store.statements, { beforeSeq: Number.NaN, limit: 8_000 }, (entries) => {
    counts.push([...entries])
    return { count: entries.length }
  }), {
    entries: [{ kind: "message", id: "b", content: "b" }, { kind: "message", id: "a", content: "a" }],
    threadCounts: { count: 2 },
  })
  assert.deepEqual(store.calls, [["window", null, null, 5_001]])
  assert.equal(counts.length, 1)
})

test("a tail falls back to its default size and uses no cursor for a non-finite sequence", () => {
  const store = statementHarness({ tailRows: [row(1, { kind: "message", id: "first", content: "first" })] })

  assert.deepEqual(loadAgentTranscriptTail(store.statements, { beforeSeq: Infinity, limit: 0 }), {
    entries: [{ kind: "message", id: "first", content: "first" }],
  })
  assert.deepEqual(store.calls, [["tail", null, null, 501]])
})
