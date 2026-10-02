/**
 * The file mirror a transcript is written through: the lines it counts, the line it writes for one message, what it
 * hydrates out of the blobs a state carries and what it leaves out, the whole write and the incremental one, and the
 * write it refuses to make.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createContext } from "../../source/packages/context/context.ts";
import {
  countTranscriptMessageLines,
  formatSingleMessageJsonl,
  LegacyFileTranscriptMirror,
  OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES,
  UnexpectedIncrementalFullWriteError,
} from "../../source/host/transcript/mirror/legacy-transcript-mirror.ts";

const open = "<" + "think>";
const close = "<" + "/think>";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const idOf = (label: string): Uint8Array => new Uint8Array(createHash("sha256").update(label).digest());
const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const messageBlob = (message: unknown): Uint8Array => textBytes(JSON.stringify(message));

/** A blob store over what the test put in it, with what it was asked for written down. */
function blobStoreOf(entries: Map<string, Uint8Array>) {
  const asked: string[] = [];
  return {
    asked,
    store: {
      async getBlob(_ctx: unknown, id: Uint8Array): Promise<Uint8Array | undefined> {
        const key = hex(id);
        asked.push(key);
        return entries.get(key);
      },
    },
  };
}

/** An archive is the repeated message-id field of a summary, encoded the way the decoder reads it. */
function archiveOf(ids: readonly Uint8Array[]): Uint8Array {
  const bytes: number[] = [];
  for (const id of ids) {
    bytes.push(0x0a, id.length, ...id);
  }
  return new Uint8Array(bytes);
}

function stateOf(parts: { prompts?: Uint8Array[]; archives?: Uint8Array[] } = {}) {
  return { turns: [], rootPromptMessagesJson: parts.prompts ?? [], summaryArchives: parts.archives ?? [] };
}

describe("the lines a transcript holds", () => {
  it("counts what a transcript holds, and not what only marks it", () => {
    const jsonl = [
      JSON.stringify({ type: "metadata", overview: "x" }),
      JSON.stringify({ role: "user", message: { content: [] } }),
      "",
      JSON.stringify({ type: "turn_ended" }),
      "not json at all",
      JSON.stringify({ role: "assistant", message: { content: [] } }),
    ].join("\n");
    assert.equal(countTranscriptMessageLines(jsonl), 3);
    assert.equal(countTranscriptMessageLines(""), 0);
  });

  it("writes one message as the line a transcript holds", () => {
    // What the platform injected around a user's words is not part of the conversation, and neither is a system
    // message or the summary of one.
    assert.equal(formatSingleMessageJsonl({ role: "system", content: "rules" } as never), undefined);
    assert.equal(formatSingleMessageJsonl({ role: "assistant", content: "s", providerOptions: { cursor: { isSummary: true } } } as never), undefined);
    assert.deepEqual(
      JSON.parse(formatSingleMessageJsonl({ role: "user", content: "<git_status>dirty</git_status>\nhello" } as never) ?? "null"),
      { role: "user", message: { content: [{ type: "text", text: "hello" }] } },
    );
    // Hidden thinking never reaches the file, and a message that is only whitespace is no line at all.
    const withHiddenThinking = `${open}weighing it${close}The answer is 2.`;
    assert.deepEqual(
      JSON.parse(formatSingleMessageJsonl({ role: "assistant", content: withHiddenThinking } as never) ?? "null"),
      { role: "assistant", message: { content: [{ type: "text", text: "The answer is 2." }] } },
    );    assert.equal(formatSingleMessageJsonl({ role: "assistant", content: "   " } as never), undefined);
    assert.equal(formatSingleMessageJsonl({ role: "assistant", content: [{ type: "tool-result", toolName: "run" }] } as never), undefined);
    // Everything else in a message is written as what it is.
    const parts = [
      { type: "text", text: "looking" },
      { type: "reasoning", text: "weighing" },
      { type: "redacted-reasoning" },
      { type: "image" },
      { type: "file", filename: "shot.png" },
      { type: "file" },
      { type: "tool-call", toolName: "run", args: { command: "ls" } },
    ];
    assert.deepEqual(JSON.parse(formatSingleMessageJsonl({ role: "assistant", content: parts } as never) ?? "null"), {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "looking\n[Image]\n[File: shot.png]\n[File]\n\nweighing\n[REDACTED]" },
          { type: "tool_use", name: "run", input: { command: "ls" } },
        ],
      },
    });
  });

  it("hands a conversation a path of its own", () => {
    const mirror = new LegacyFileTranscriptMirror("/transcripts");
    assert.equal(mirror.jsonlPathFor("conv-1"), join("/transcripts", "conv-1", "conv-1.jsonl"));
    // An id that is not a path stays one file name.
    assert.equal(mirror.jsonlPathFor("a/b c"), join("/transcripts", "a_2Fb_20c", "a_2Fb_20c.jsonl"));
    assert.equal(OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES, 5_000_000);
    assert.equal(new UnexpectedIncrementalFullWriteError("x").name, "UnexpectedIncrementalFullWriteError");
  });
});

describe("writing a transcript through the mirror", () => {
  it("writes the whole transcript, and refuses to lose lines it already wrote", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-legacy-mirror-"));
    const mirror = new LegacyFileTranscriptMirror(directory);
    const one = idOf("one");
    const two = idOf("two");
    const three = idOf("three");
    const blobs = new Map<string, Uint8Array>([
      [hex(one), messageBlob({ role: "user", content: "one" })],
      [hex(two), messageBlob({ role: "assistant", content: "two" })],
      [hex(three), messageBlob({ role: "assistant", content: "three" })],
    ]);
    const store = blobStoreOf(blobs);
    const ctx = createContext();
    assert.equal(await mirror.writeFull(ctx, "conv-1", stateOf({ prompts: [one, two] }), store.store), true);
    const path = mirror.jsonlPathFor("conv-1");
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 2);
    // Only the transcript itself is written, not the other forms of it.
    assert.deepEqual(readdirSync(join(directory, "conv-1")).sort(), ["conv-1.jsonl"]);
    // A state that holds less than the file does is refused rather than written: the file keeps what it had, and the
    // write says it did not happen.
    assert.equal(await mirror.writeFull(ctx, "conv-1", stateOf({ prompts: [one] }), store.store), false);
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 2);
    // A state that holds more is written.
    assert.equal(await mirror.writeFull(ctx, "conv-1", stateOf({ prompts: [one, two, three] }), store.store), true);
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 3);
    // A conversation with nothing to write is written successfully without a file at all.
    assert.equal(await mirror.writeFull(ctx, "conv-2", stateOf(), store.store), true);
    assert.throws(() => readFileSync(mirror.jsonlPathFor("conv-2"), "utf8"), /ENOENT/);
  });

  it("appends only what is new when the transcript moved forward", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-legacy-mirror-"));
    const mirror = new LegacyFileTranscriptMirror(directory);
    const one = idOf("one");
    const two = idOf("two");
    const three = idOf("three");
    const blobs = new Map<string, Uint8Array>([
      [hex(one), messageBlob({ role: "user", content: "one" })],
      [hex(two), messageBlob({ role: "assistant", content: "two" })],
      [hex(three), messageBlob({ role: "assistant", content: "three" })],
    ]);
    const store = blobStoreOf(blobs);
    const ctx = createContext();
    await mirror.writeFull(ctx, "conv-1", stateOf({ prompts: [one, two] }), store.store);
    const path = mirror.jsonlPathFor("conv-1");
    assert.equal(await mirror.writeIncremental(ctx, "conv-1", stateOf({ prompts: [one, two, three] }), store.store, 2), 3);
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 3);
    // Nothing new to append is nothing to do, and a state that lost a message is not written either.
    const askedBefore = store.asked.length;
    assert.equal(await mirror.writeIncremental(ctx, "conv-1", stateOf({ prompts: [one, two, three] }), store.store, 0), null);
    assert.equal(await mirror.writeIncremental(ctx, "conv-1", stateOf({ prompts: [one, two] }), store.store, 3), null);
    // Neither of those even asked the blobs for anything.
    assert.deepEqual(store.asked.length, askedBefore);
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 3);
    // Nothing new is nothing to do: the store answers with how many messages the state holds rather than writing
    // again, and the mirror's guard against a full write in the incremental path is never reached for it.
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      assert.equal(await mirror.writeIncremental(ctx, "conv-1", stateOf({ prompts: [one, two, three] }), store.store, 3), 3);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(logged, []);
    assert.deepEqual(countTranscriptMessageLines(readFileSync(path, "utf8")), 3);
  });

  it("writes what a state carries, and leaves out what it cannot read", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-legacy-mirror-"));
    const mirror = new LegacyFileTranscriptMirror(directory);
    const archived = idOf("archived");
    const asked = idOf("asked");
    const system = idOf("system");
    const summary = idOf("summary");
    const unreadable = idOf("unreadable");
    const binary = idOf("binary");
    const blobs = new Map<string, Uint8Array>([
      [hex(archived), messageBlob({ role: "assistant", content: "from the archive" })],
      [hex(asked), messageBlob({ role: "user", content: "what the user asked" })],
      [hex(system), messageBlob({ role: "system", content: "the rules" })],
      [hex(summary), messageBlob({ role: "assistant", content: "a summary", providerOptions: { cursor: { isSummary: true } } })],
      [hex(unreadable), textBytes("not a message at all")],
      // A message whose text was stored as raw bytes is written as the placeholder rather than as bytes.
      [hex(binary), textBytes(JSON.stringify({ role: "user", content: [{ type: "text", text: { __type: "Uint8Array", hex: "aabb" } }] }))],
      [hex(idOf("archive")), archiveOf([archived])],
    ]);
    const store = blobStoreOf(blobs);
    await mirror.writeFull(createContext(), "conv-1", stateOf({ prompts: [asked, system, summary, unreadable, binary], archives: [idOf("archive"), idOf("unreadable-archive")] }), store.store);
    const lines = readFileSync(mirror.jsonlPathFor("conv-1"), "utf8").split("\n").filter((line) => line.length > 0);
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as { role: string }).role), ["assistant", "user", "user"]);
    const texts = lines.map((line) => (JSON.parse(line) as { message: { content: Array<{ text?: string }> } }).message.content.map((part) => part.text).join(""));
    assert.deepEqual(texts, ["from the archive", "what the user asked", "[Binary data omitted from transcript: 2 bytes]"]);
    // When the transcript opens with two messages from the user, the first is the platform's own nudge, not the talk.
    const nudge = idOf("nudge");
    blobs.set(hex(nudge), messageBlob({ role: "user", content: "nudge" }));
    await mirror.writeFull(createContext(), "conv-2", stateOf({ prompts: [nudge, asked] }), store.store);
    const nudged = readFileSync(mirror.jsonlPathFor("conv-2"), "utf8").split("\n").filter((line) => line.length > 0);
    assert.deepEqual(nudged.length, 1);
    assert.equal(nudged[0]?.includes("nudge"), false);
    // The archives are read first (both of them, together), the message inside the readable one is read next, and the
    // prompt messages follow.
    assert.deepEqual(store.asked.slice(0, 2), [hex(idOf("archive")), hex(idOf("unreadable-archive"))]);
    assert.equal(store.asked.indexOf(hex(archived)) >= 2, true);
    assert.equal(store.asked.indexOf(hex(asked)) > store.asked.indexOf(hex(archived)), true);
  });

  it("says how much of an oversize blob it dropped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-legacy-mirror-"));
    const mirror = new LegacyFileTranscriptMirror(directory);
    const huge = idOf("huge");
    const store = blobStoreOf(new Map([[hex(huge), new Uint8Array(OVERSIZE_TRANSCRIPT_BLOB_THRESHOLD_BYTES + 1)]]));
    await mirror.writeFull(createContext(), "conv-1", stateOf({ prompts: [huge] }), store.store);
    const line = readFileSync(mirror.jsonlPathFor("conv-1"), "utf8").trim();
    assert.deepEqual(JSON.parse(line), { role: "assistant", message: { content: [{ type: "text", text: "[Oversize transcript blob omitted: 5.0 MB]" }] } });
  });
});
