/**
 * What the journal mirror owns, prepares, commits, replays and refuses when the canonical transcript changes.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TranscriptJournalCorruptionError,
  type TranscriptCheckpoint,
} from "../../source/host/transcript/mirror/transcript-journal-codec.ts";
import { FileTranscriptMirror, type TranscriptDeriver } from "../../source/host/transcript/mirror/transcript-mirror.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function world(options: {
  readonly initial?: TranscriptDeriver<string>["initial"];
  readonly derive?: TranscriptDeriver<string>["derive"];
  readonly withDeriver?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "slate-file-transcript-mirror-"));
  const directory = join(root, "transcripts");
  const reports: Array<Record<string, unknown>> = [];
  const defaultDeriver: TranscriptDeriver<string> = {
    initial: async (_ctx, _store, state) => state.turns.map((turn, index) => ({
      id: "initial-" + index,
      line: messageLine(Buffer.from(turn).toString("utf8")),
    })),
    derive: async (_ctx, _store, _previous, state, _finalize, deferredStep) => {
      const text = "turn-" + state.turns.length;
      return {
        occurrences: [{ id: text, line: messageLine(text) }],
        ...(deferredStep == null
          ? { deferredStep: { turnIndex: state.turns.length - 1, stepIndex: 0 } }
          : { deferredStep }),
      };
    },
  };
  const deriver: TranscriptDeriver<string> | undefined = options.withDeriver === false
    ? undefined
    : { initial: options.initial ?? defaultDeriver.initial, derive: options.derive ?? defaultDeriver.derive };
  const mirror = new FileTranscriptMirror(directory, (report) => reports.push(report as unknown as Record<string, unknown>), deriver);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, mirror, reports };
}

function checkpoint(...turns: string[]): TranscriptCheckpoint {
  return { turns: turns.map((turn) => Buffer.from(turn, "utf8")) };
}

function messageLine(text: string): string {
  return JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });
}

describe("journal paths and ownership", () => {
  it("keeps the canonical JSONL and journal sidecars beneath a safe conversation id", () => {
    const current = world();
    assert.deepEqual(
      [
        current.mirror.jsonlPathFor("conversation-1"),
        current.mirror.pendingPathFor("conversation-1"),
        current.mirror.cursorPathFor("conversation-1"),
        current.mirror.modePathFor("conversation-1"),
      ],
      [
        join(current.directory, "conversation-1", "conversation-1.jsonl"),
        join(current.directory, "conversation-1", "conversation-1.journal-pending.json"),
        join(current.directory, "conversation-1", "conversation-1.journal-cursor.json"),
        join(current.directory, "conversation-1", "conversation-1.journal-mode"),
      ],
    );
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "with space", "nul\0id"]) {
      assert.throws(() => current.mirror.jsonlPathFor(invalid), TranscriptJournalCorruptionError);
    }
  });

  it("claims a conversation once and remembers the journal marker on disk", async () => {
    const current = world();
    assert.equal(await current.mirror.ownsConversation("conv"), false);
    await current.mirror.claimConversation("conv");
    assert.equal(await current.mirror.ownsConversation("conv"), true);
    await current.mirror.claimConversation("conv");
    assert.equal(readFileSync(current.mirror.modePathFor("conv"), "utf8"), "1\n");
  });
});

describe("recovering and appending a transcript", () => {
  it("rebuilds the initial JSONL from a checkpoint and reports its replay outcome", async () => {
    const current = world();
    await current.mirror.recover({}, "conv", checkpoint("one", "two"), "store");
    assert.equal(readFileSync(current.mirror.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n" + messageLine("two") + "\n");
    assert.deepEqual(current.reports.map((report) => [report.op, report.outcome, report.conversationId]), [["replay", "ok", "conv"]]);
    assert.equal(current.mirror.durableCheckpoints.has("conv"), true);
  });

  it("writes a pending WAL at prepare and appends it only at commit", async () => {
    const current = world();
    const first = checkpoint("one");
    const next = checkpoint("one", "two");
    await current.mirror.recover({}, "conv", first, "store");

    const prepared = await current.mirror.prepareCheckpoint({}, "conv", next, "store", true) as { entryCount: number; bytes: number };
    assert.equal(prepared.entryCount, 1);
    assert.equal(prepared.bytes > 0, true);
    assert.equal(existsSync(current.mirror.pendingPathFor("conv")), true);
    assert.equal(readFileSync(current.mirror.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n");
    assert.deepEqual(current.mirror.preparedDeferredSteps.get("conv"), { turnIndex: 1, stepIndex: 0 });

    const committed = await current.mirror.commitCheckpoint({}, "conv") as { entryCount: number; bytes: number };
    assert.equal(committed.entryCount, 1);
    assert.equal(committed.bytes > 0, true);
    assert.equal(existsSync(current.mirror.pendingPathFor("conv")), false);
    assert.equal(readFileSync(current.mirror.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n" + messageLine("turn-2") + "\n");
    assert.deepEqual(current.mirror.deferredSteps.get("conv"), { turnIndex: 1, stepIndex: 0 });
    assert.deepEqual(current.mirror.durableCheckpoints.get("conv"), next);
  });

  it("retains a prepared step with no occurrences without appending a duplicate full transcript", async () => {
    const current = world({ derive: async () => ({ occurrences: [] }) });
    const first = checkpoint("one");
    await current.mirror.recover({}, "conv", first, "store");
    await current.mirror.prepareCheckpoint({}, "conv", checkpoint("one", "two"), "store");
    assert.equal(existsSync(current.mirror.pendingPathFor("conv")), true);
    await current.mirror.commitCheckpoint({}, "conv");
    assert.equal(readFileSync(current.mirror.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n");
  });

  it("aborts a prepared WAL and leaves the canonical transcript unchanged", async () => {
    const current = world();
    const first = checkpoint("one");
    await current.mirror.recover({}, "conv", first, "store");
    await current.mirror.prepareCheckpoint({}, "conv", checkpoint("one", "two"), "store", true);
    await current.mirror.abortCheckpoint({}, "conv");
    assert.equal(existsSync(current.mirror.pendingPathFor("conv")), false);
    assert.equal(readFileSync(current.mirror.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n");
    assert.equal(current.mirror.preparedCheckpoints.has("conv"), false);
  });

  it("replays a committed WAL after restart exactly once, including its deferred cursor", async () => {
    const current = world();
    const first = checkpoint("one");
    const next = checkpoint("one", "two");
    await current.mirror.recover({}, "conv", first, "store");
    await current.mirror.prepareCheckpoint({}, "conv", next, "store", true);

    const resumed = new FileTranscriptMirror(current.directory, () => {}, current.mirror.deriver);
    await resumed.recover({}, "conv", next, "store");
    const expected = messageLine("one") + "\n" + messageLine("turn-2") + "\n";
    assert.equal(readFileSync(resumed.jsonlPathFor("conv"), "utf8"), expected);
    assert.equal(existsSync(resumed.pendingPathFor("conv")), false);
    assert.deepEqual(resumed.deferredSteps.get("conv"), { turnIndex: 1, stepIndex: 0 });
    await resumed.recover({}, "conv", next, "store");
    assert.equal(readFileSync(resumed.jsonlPathFor("conv"), "utf8"), expected);
  });

  it("drops a pending WAL when recovery still presents its previous durable checkpoint", async () => {
    const current = world();
    const first = checkpoint("one");
    await current.mirror.recover({}, "conv", first, "store");
    await current.mirror.prepareCheckpoint({}, "conv", checkpoint("one", "two"), "store", true);

    const resumed = new FileTranscriptMirror(current.directory, () => {}, current.mirror.deriver);
    await resumed.recover({}, "conv", first, "store");
    assert.equal(existsSync(resumed.pendingPathFor("conv")), false);
    assert.equal(readFileSync(resumed.jsonlPathFor("conv"), "utf8"), messageLine("one") + "\n");
  });

  it("refuses to prepare a checkpoint after the canonical file changes outside the journal", async () => {
    const current = world();
    await current.mirror.recover({}, "conv", checkpoint("one"), "store");
    writeFileSync(current.mirror.jsonlPathFor("conv"), messageLine("outside") + "\n", "utf8");
    await assert.rejects(
      current.mirror.prepareCheckpoint({}, "conv", checkpoint("one", "two"), "store"),
      TranscriptJournalCorruptionError,
    );
  });

  it("rejects duplicate occurrence ids and a mirror without an occurrence deriver", async () => {
    const duplicates = world({ derive: async () => ({ occurrences: [
      { id: "same", line: messageLine("one") },
      { id: "same", line: messageLine("two") },
    ] }) });
    const first = checkpoint("one");
    await duplicates.mirror.recover({}, "conv", first, "store");
    await assert.rejects(
      duplicates.mirror.prepareCheckpoint({}, "conv", checkpoint("one", "two"), "store"),
      (error: unknown) => error instanceof TranscriptJournalCorruptionError && /was derived twice/.test(error.message),
    );
    assert.equal(existsSync(duplicates.mirror.pendingPathFor("conv")), false);

    const missing = world({ withDeriver: false });
    await assert.rejects(missing.mirror.recover({}, "conv", first, "store"), /derivation is unavailable/);
    assert.equal(missing.reports[0]?.op, "replay");
  });

  it("reports a repeated failure object only once", async () => {
    const failure = new Error("cannot derive occurrences");
    const current = world({ derive: async () => { throw failure; } });
    const first = checkpoint("one");
    await current.mirror.recover({}, "conv", first, "store");
    const next = checkpoint("one", "two");
    await assert.rejects(current.mirror.prepareCheckpoint({}, "conv", next, "store"), (error) => error === failure);
    await assert.rejects(current.mirror.prepareCheckpoint({}, "conv", next, "store"), (error) => error === failure);
    assert.equal(current.reports.filter((report) => report.outcome === "failed").length, 1);
    assert.equal(current.reports.find((report) => report.outcome === "failed")?.op, "checkpoint");
  });
});
