import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TranscriptJournalCorruptionError,
  TranscriptJournalWriteError,
  TranscriptOccurrenceConflictError,
  bytesEqual,
  checkpointIdentity,
  fileIdentity,
  formatTextLine,
  formatToolLine,
  isMissingFile,
  parseDeferredStep,
  parsePendingCheckpoint,
  sha256,
} from "../../source/host/transcript/mirror/transcript-journal-codec.ts";

const digest = (fill: string) => fill.repeat(64);
const cursor = { turnCount: 0 };
const checkpointRecord = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    previousCheckpointHash: digest("a"),
    checkpointHash: digest("b"),
    appendOffset: 0,
    fileDevice: "16777220",
    fileInode: "1234",
    lines: [],
    cursor,
    ...overrides,
  });
const line = (value: unknown) => JSON.stringify(value);

/** A handle that takes the given amounts, recording every write it was asked for. */
function writeHandle(plan: number[], failOnCall?: number) {
  const calls: Array<{ offset: number; length: number; position: number }> = [];
  let call = 0;
  return {
    calls,
    handle: {
      async write(_bytes: Uint8Array, offset: number, length: number, position: number) {
        if (failOnCall === call) throw new Error("write failed");
        calls.push({ offset, length, position });
        const bytesWritten = plan[Math.min(call, plan.length - 1)] ?? 0;
        call += 1;
        return { bytesWritten, buffer: _bytes };
      },
    },
  };
}

describe("the journal's digests", () => {
  it("hashes and compares bytes", () => {
    assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256(Buffer.from("abc")), sha256("abc"));
    assert.equal(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(bytesEqual(new Uint8Array([]), new Uint8Array([])), true);
  });

  it("identifies a checkpoint by the last two of its turns", () => {
    assert.equal(checkpointIdentity({ turns: [] }), sha256("0::"));
    assert.equal(checkpointIdentity({ turns: [new Uint8Array([1, 2])] }), sha256("1::0102"));
    assert.equal(
      checkpointIdentity({ turns: [new Uint8Array([9]), new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])] }),
      sha256("3:0102:030405"),
      "only the last two turns count",
    );
  });
});

describe("what a journal failure reports", () => {
  it("recognizes the missing-file code, and only on an error", () => {
    assert.equal(isMissingFile(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
    assert.equal(isMissingFile(Object.assign(new TypeError("missing"), { code: "ENOENT" })), true);
    assert.equal(isMissingFile(Object.assign(new Error("denied"), { code: "EACCES" })), false);
    assert.equal(isMissingFile(new Error("plain")), false);
    assert.equal(isMissingFile({ code: "ENOENT" }), false, "a non-error is not a file failure");
    assert.equal(isMissingFile("ENOENT"), false);
  });

  it("describes a file's identity with text sizes", () => {
    assert.deepEqual(fileIdentity({ size: 12, dev: 3, ino: 4 }), { size: 12, device: "3", inode: "4" });
    assert.deepEqual(fileIdentity({ size: 12n, dev: 3n, ino: 4n }), { size: 12, device: "3", inode: "4" });
    assert.deepEqual(Object.keys(fileIdentity({ size: 0, dev: 0, ino: 0 })), ["size", "device", "inode"]);
  });

  it("had the three error classes the mirror raises", () => {
    for (const ErrorClass of [TranscriptOccurrenceConflictError, TranscriptJournalCorruptionError, TranscriptJournalWriteError]) {
      const error = new ErrorClass("the message");
      assert.equal(error instanceof Error, true);
      assert.equal(error.name, ErrorClass.name);
      assert.equal(error.message, "the message");
      assert.deepEqual(Object.keys(error), ["name"], "the name is an own enumerable field");
    }
  });
});

describe("the deferred step a checkpoint cursor may hold", () => {
  it("reads a pair of indices, and nothing when the cursor holds none", () => {
    assert.equal(parseDeferredStep(undefined), undefined);
    assert.equal(parseDeferredStep(null), undefined);
    assert.deepEqual(parseDeferredStep({ turnIndex: 5, stepIndex: 3 }), { turnIndex: 5, stepIndex: 3 });
    assert.deepEqual(parseDeferredStep({ turnIndex: 5, stepIndex: 3, extra: true }), { turnIndex: 5, stepIndex: 3 });
  });

  it("reports anything that is not a pair of non-negative whole numbers", () => {
    for (const value of [
      {},
      [],
      "1",
      1,
      { turnIndex: -1, stepIndex: 0 },
      { turnIndex: 0, stepIndex: -1 },
      { turnIndex: 1.5, stepIndex: 0 },
      { turnIndex: "1", stepIndex: 0 },
      { turnIndex: 0, stepIndex: null },
      Object.assign([], { turnIndex: 1, stepIndex: 1 }),
    ]) {
      assert.throws(() => parseDeferredStep(value), { name: "TranscriptJournalCorruptionError", message: "transcript deferred cursor is invalid" }, JSON.stringify(value));
    }
  });
});

describe("a pending checkpoint", () => {
  it("is read back with its fields in the order the format writes them", () => {
    const parsed = parsePendingCheckpoint(checkpointRecord());
    assert.deepEqual(parsed, {
      version: 1,
      previousCheckpointHash: digest("a"),
      checkpointHash: digest("b"),
      appendOffset: 0,
      fileDevice: "16777220",
      fileInode: "1234",
      lines: [],
      cursor: { turnCount: 0 },
    });
    assert.deepEqual(Object.keys(parsed), ["version", "previousCheckpointHash", "checkpointHash", "appendOffset", "fileDevice", "fileInode", "lines", "cursor"]);
  });

  it("keeps the stored lines as they were written", () => {
    const storedLine = line({ role: "user", message: { content: [{ type: "text", text: "hi" }] } });
    const parsed = parsePendingCheckpoint(checkpointRecord({ lines: [storedLine] }));
    assert.deepEqual(parsed.lines, [storedLine]);
  });

  it("carries the deferred step when the cursor holds one", () => {
    const parsed = parsePendingCheckpoint(checkpointRecord({ slate: { turnCount: 2, deferredStep: { turnIndex: 1, stepIndex: 0 } } }));
    assert.deepEqual(parsed.cursor, { turnCount: 2, deferredStep: { turnIndex: 1, stepIndex: 0 } });
    assert.deepEqual(Object.keys(parsed.cursor), ["turnCount", "deferredStep"]);
    assert.deepEqual(Object.keys(parsePendingCheckpoint(checkpointRecord()).cursor), ["turnCount"], "a cursor without one has no key");
  });

  it("reports corruption, with the cause kept for an unreadable text", () => {
    const corrupted = (raw: string, message: string, detail = raw) =>
      assert.throws(() => parsePendingCheckpoint(raw), { name: "TranscriptJournalCorruptionError", message }, detail);
    corrupted("not json at all", "pending transcript checkpoint is not valid JSON");
    assert.throws(
      () => parsePendingCheckpoint("not json at all"),
      (error: Error & { cause?: unknown }) => error instanceof TranscriptJournalCorruptionError && error.cause instanceof SyntaxError,
      "the parse failure is kept as the cause",
    );
    corrupted("null", "pending transcript checkpoint is not an object");
    corrupted("[]", "pending transcript checkpoint is not an object");
    corrupted(checkpointRecord({ version: 2 }), "pending transcript checkpoint metadata is invalid");
    corrupted(checkpointRecord({ previousCheckpointHash: "abc" }), "pending transcript checkpoint metadata is invalid");
    corrupted(checkpointRecord({ appendOffset: -1 }), "pending transcript checkpoint metadata is invalid");
    corrupted(checkpointRecord({ lines: "one" }), "pending transcript checkpoint metadata is invalid");
    corrupted(checkpointRecord({ cursor: null }), "pending transcript checkpoint metadata is invalid");
    corrupted(checkpointRecord({ lines: [7] }), "pending transcript line is invalid");
    corrupted(checkpointRecord({ lines: ["not json"] }), "pending transcript line is invalid");
    corrupted(checkpointRecord({ lines: ["null"] }), "pending transcript line does not use the legacy message envelope");
    corrupted(checkpointRecord({ lines: [line({ role: "user" })] }), "pending transcript line does not use the legacy message envelope");
    corrupted(checkpointRecord({ lines: [line({ message: { content: [] } })] }), "pending transcript line does not use the legacy message envelope", "a line without a role is not the envelope");
    corrupted(checkpointRecord({ cursor: [] }), "pending transcript checkpoint metadata is invalid", "a cursor has to be a record");
    corrupted(checkpointRecord({ cursor: "cursor" }), "pending transcript checkpoint metadata is invalid", "a cursor has to be a record");
    corrupted(checkpointRecord({ slate: { turnCount: -1 } }), "pending transcript checkpoint cursor is invalid");
    corrupted(checkpointRecord({ slate: { turnCount: 0, deferredStep: { turnIndex: -1, stepIndex: 0 } } }), "transcript deferred cursor is invalid");
  });

  it("reports the first corruption the format checks for", () => {
    assert.throws(
      () => parsePendingCheckpoint(checkpointRecord({ lines: ["oops"], cursor: { turnCount: -1 } })),
      { message: "pending transcript line is invalid" },
      "the stored lines are checked before the cursor",
    );
    assert.throws(
      () => parsePendingCheckpoint(checkpointRecord({ version: 2, lines: ["oops"] })),
      { message: "pending transcript checkpoint metadata is invalid" },
      "the metadata is checked before the lines",
    );
  });
});

describe("writing a journal", () => {
  it("asks the handle for the rest at the position it has reached", async () => {
    const { handle, calls } = writeHandle([3, 4]);
    const written = await writeAllForTest(handle, new Uint8Array(7), 100);
    assert.equal(written, 107);
    assert.deepEqual(calls, [
      { offset: 0, length: 7, position: 100 },
      { offset: 3, length: 4, position: 103 },
    ]);
  });

  it("reports a write that made no progress", async () => {
    const { handle } = writeHandle([0]);
    await assert.rejects(writeAllForTest(handle, new Uint8Array(3), 0), {
      name: "TranscriptJournalWriteError",
      message: "transcript JSONL write made no progress",
    });
  });

  it("does not touch a handle for nothing to write", async () => {
    const { handle, calls } = writeHandle([]);
    assert.equal(await writeAllForTest(handle, new Uint8Array(0), 42), 42);
    assert.deepEqual(calls, []);
  });

  it("lets a write failure out", async () => {
    const { handle } = writeHandle([1], 0);
    await assert.rejects(writeAllForTest(handle, new Uint8Array(2), 0), { message: "write failed" });
  });
});

async function writeAllForTest(handle: unknown, bytes: Uint8Array, position: number): Promise<number> {
  const module = await import("../../source/host/transcript/mirror/transcript-journal-codec.ts");
  return module.writeAll(handle as never, bytes, position);
}

describe("the line formats", () => {
  it("writes a text message in the legacy envelope", () => {
    assert.equal(formatTextLine("user", "hi"), '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}');
    assert.equal(formatTextLine("assistant", "a longer answer"), '{"role":"assistant","message":{"content":[{"type":"text","text":"a longer answer"}]}}');
    assert.equal(formatTextLine("user", ""), null);
    assert.equal(formatTextLine("user", 'a "quoted"\nline'), JSON.stringify({ role: "user", message: { content: [{ type: "text", text: 'a "quoted"\nline' }] } }));
  });

  it("writes a tool call as a use for the assistant and a result for the tool", () => {
    assert.equal(
      formatToolLine("assistant", "search", { query: "hello" }),
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"search","input":{"query":"hello"}}]}}',
    );
    assert.equal(
      formatToolLine("tool", "search", { found: 2 }),
      '{"role":"tool","message":{"content":[{"type":"tool_result","name":"search","result":{"found":2}}]}}',
    );
    assert.equal(
      formatToolLine("assistant", "read", undefined),
      '{"role":"assistant","message":{"content":[{"type":"tool_use","name":"read"}]}}',
      "an undefined payload is left out of the JSON",
    );
    assert.equal(
      formatToolLine("tool", "read", null),
      '{"role":"tool","message":{"content":[{"type":"tool_result","name":"read","result":null}]}}',
    );
  });
});