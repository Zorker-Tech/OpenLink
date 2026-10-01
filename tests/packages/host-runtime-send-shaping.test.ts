/**
 * What a message the agent sends looks like once it arrives: the entry it becomes, what may be quoted from it, the
 * pictures with it, and how it is threaded into the conversation.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildComposedOfflineNote, buildSelectedVideos, collectInboundImages, createSendMessageEntry, createUserAttachmentEntry, createUserMessage, describeMessageQuote, describeReactedMessageQuote, describeRepliedMessageQuote, isUserMessageEntry, quotableEntryText, skippablePromptSummary, splitAttachmentPathsByChannel, stampBoxRequestEntry, statAttachedFileSizes, stripReplyTo, toggleReaction, withReplyTo } from "../../source/host/transcript/send-message-shaping.ts";

describe("a message the agent sent, as the conversation keeps it", () => {
  it("says which entries are the user's own", () => {
    assert.equal(isUserMessageEntry({ kind: "message", role: "user" } as never), true);
    assert.equal(isUserMessageEntry({ kind: "user-attachment" } as never), true);
    assert.equal(isUserMessageEntry({ kind: "message", role: "agent" } as never), false);
    assert.equal(isUserMessageEntry({ kind: "send-message" } as never), false);
    assert.equal(isUserMessageEntry({ kind: "notice" } as never), false);
  });

  it("adds a reaction, takes the same one back, and has none left when the last goes", () => {
    assert.deepEqual(toggleReaction(undefined, "👍", "user-1"), [{ emoji: "👍", by: "user-1" }]);
    // The same person reacting again is the same person changing their mind.
    assert.equal(toggleReaction([{ emoji: "👍", by: "user-1" }], "👍", "user-1"), undefined);
    // Somebody else's reaction is their own.
    assert.deepEqual(toggleReaction([{ emoji: "👍", by: "user-1" }], "👍", "user-2"), [{ emoji: "👍", by: "user-1" }, { emoji: "👍", by: "user-2" }]);
    assert.deepEqual(toggleReaction([{ emoji: "👍", by: "user-1" }, { emoji: "👍", by: "user-2" }], "👍", "user-1"), [{ emoji: "👍", by: "user-2" }]);
  });

  it("quotes what a message said, and says nothing when it said nothing", () => {
    assert.equal(quotableEntryText({ kind: "message", content: "hi" } as never), "hi");
    // An entry whose content is not text has nothing to quote.
    assert.equal(quotableEntryText({ kind: "message", content: 7 } as never), "");
    assert.equal(quotableEntryText({ kind: "send-message", message: { type: "text", content: "there" } } as never), "there");
    assert.equal(quotableEntryText({ kind: "send-message", message: { type: "widget" } } as never), "");
    assert.equal(quotableEntryText({ kind: "notice", id: "n1" } as never), "");
    // What is quoted is one line, and an entry with nothing in it is quoted by its id instead.
    assert.equal(describeMessageQuote({ kind: "message", id: "e1", content: "  a\n   b  " } as never), "a b");
    assert.equal(describeMessageQuote({ kind: "message", id: "e2", content: "   " } as never), "e2");
    assert.equal(describeMessageQuote({ kind: "message", id: "e3", content: "x".repeat(50) } as never, 10), `${"x".repeat(10)}…`);
    // A reaction quotes a short form; a reply quotes the whole message.
    assert.equal(describeReactedMessageQuote({ kind: "message", id: "e4", content: "y".repeat(100) } as never).length, 81);
    assert.equal(describeRepliedMessageQuote({ kind: "message", id: "e5", content: "y".repeat(100) } as never).length, 100);
  });

  it("marks a message that was written while the host was away", () => {
    assert.equal(buildComposedOfflineNote(0), "[Composed offline at 1970-01-01T00:00:00.000Z]");
    assert.equal(buildComposedOfflineNote(Number.NaN), "");
  });

  it("builds a user's message with only what it was given", () => {
    const message = createUserMessage("entry-1", "hello", { composedAtMs: 1_000, richText: "<p>hello</p>", replyTo: "entry-0", batchId: "batch-1", branched: true, clientNonce: "nonce-1" });
    assert.deepEqual(message, { kind: "message", id: "entry-1", role: "user", content: "hello", richText: "<p>hello</p>", isStreaming: false, timestampMs: 1_000, replyTo: "entry-0", batchId: "batch-1", branched: true, clientNonce: "nonce-1", sentWhileOfflineAtMs: 1_000 });
    // What was not given is not carried, and a message written now is stamped now.
    const bare = createUserMessage("entry-2", "hi");
    assert.deepEqual(Object.keys(bare), ["kind", "id", "role", "content", "richText", "isStreaming", "timestampMs"]);
    assert.equal(Math.abs((bare as { timestampMs: number }).timestampMs - Date.now()) < 5_000, true);
    // A time that is not a time is not a time, and neither is an empty rich text or nonce.
    const odd = createUserMessage("entry-3", "hi", { composedAtMs: Number.NaN, richText: "", clientNonce: "" });
    assert.deepEqual(Object.keys(odd), ["kind", "id", "role", "content", "richText", "isStreaming", "timestampMs"]);
    assert.equal((odd as { timestampMs: number }).timestampMs > 0, true);
  });

  it("builds the entry a sent message becomes, threaded only when it replies to something", () => {
    assert.deepEqual(createSendMessageEntry("entry-1", { type: "text", content: "hi", reply_to: "entry-0" }, 42), { kind: "send-message", id: "entry-1", message: { type: "text", content: "hi", reply_to: "entry-0" }, timestampMs: 42, replyTo: "entry-0" });
    // An empty reply is not a reply, even though the message still carries the field.
    assert.deepEqual(createSendMessageEntry("entry-2", { type: "text", content: "hi", reply_to: "" }, 42), { kind: "send-message", id: "entry-2", message: { type: "text", content: "hi", reply_to: "" }, timestampMs: 42 });
    // What a request from the box was asked to do travels with the entry it belongs to.
    assert.deepEqual(stampBoxRequestEntry({ kind: "message", id: "entry-3" }, { requestId: "request-1", instruction: "do it" }), { kind: "message", id: "entry-3", boxRequestId: "request-1", boxInstruction: "do it" });
  });

  it("builds the entry a file the user attached becomes", async () => {
    const measured = await createUserAttachmentEntry({ readImageDimensions: async (path) => (path.endsWith(".png") ? { width: 10, height: 20 } : null) }, "attachment-1", "/tmp/picture.png", { fileName: "  picture.png  ", batchId: "batch-1", clientNonce: "nonce-1", byteSize: 12, replyTo: "entry-0", branched: true });
    assert.deepEqual(measured, { kind: "user-attachment", id: "attachment-1", file_path: "/tmp/picture.png", file_name: "picture.png", batchId: "batch-1", clientNonce: "nonce-1", width: 10, height: 20, byteSize: 12, replyTo: "entry-0", branched: true });
    // A file whose size the platform cannot measure has no dimensions, and what was not given is not carried.
    assert.deepEqual(await createUserAttachmentEntry({ readImageDimensions: async () => null }, "attachment-2", "/tmp/notes.pdf"), { kind: "user-attachment", id: "attachment-2", file_path: "/tmp/notes.pdf", width: undefined, height: undefined, byteSize: undefined });
  });

  it("keeps a message's own fields when it is threaded, and leaves the rest alone", () => {
    const kept: Record<string, Record<string, unknown>> = {
      text: { type: "text", content: "c", images: [{ url: "u" }] },
      widget: { type: "widget", widget: { prompt: "Keep?" } },
      "cursor-agent": { type: "cursor-agent", bcId: "because-1" },
      "secret-request": { type: "secret-request", secretRequest: { field: 1 } },
      "permission-request": { type: "permission-request", permission: { scope: "read" } },
    };
    for (const message of Object.values(kept)) {
      assert.deepEqual(withReplyTo({ ...message } as never, "entry-0"), { ...message, reply_to: "entry-0" });
      assert.deepEqual(stripReplyTo({ ...message, reply_to: "entry-0" } as never), message);
    }
    // The types that carry more than one field keep every one of them, in both directions.
    const connector = { type: "connector", connector: { id: "c" }, variant: "v", serverId: "s", reason: "r", suggestions: ["s"] };
    assert.deepEqual(withReplyTo({ ...connector } as never, "entry-0"), { ...connector, reply_to: "entry-0" });
    assert.deepEqual(stripReplyTo({ ...connector, reply_to: "entry-0" } as never), connector);
    const connectors = { type: "connectors", connectors: [{ id: "a" }, { id: "b" }], reason: "r" };
    assert.deepEqual(withReplyTo({ ...connectors } as never, "entry-0"), { ...connectors, reply_to: "entry-0" });
    assert.deepEqual(stripReplyTo({ ...connectors, reply_to: "entry-0" } as never), connectors);
    const listener = { type: "listener-connect", platform: "slack", reason: "r" };
    assert.deepEqual(withReplyTo({ ...listener } as never, "entry-0"), { ...listener, reply_to: "entry-0" });
    assert.deepEqual(stripReplyTo({ ...listener, reply_to: "entry-0" } as never), listener);
    const attachment = { type: "attachment", url: "https://example.invalid/f.png", file_name: "f.png", alt: "a picture", channel: "ch", width: 1, height: 2 };
    assert.deepEqual(withReplyTo({ ...attachment } as never, "entry-0"), { ...attachment, reply_to: "entry-0" });
    assert.deepEqual(stripReplyTo({ ...attachment, reply_to: "entry-0" } as never), attachment);
    // A message this build cannot shape is not threaded at all: it is handed on exactly as it came, so a reply is not
    // added to it and one that is already there is not taken away either.
    const unknown = { type: "mystery", content: "c", extra: "kept" };
    assert.deepEqual(withReplyTo({ ...unknown } as never, "entry-0"), unknown);
    assert.deepEqual(stripReplyTo({ type: "mystery", content: "c", reply_to: "entry-0" } as never), { type: "mystery", content: "c", reply_to: "entry-0" });
    // Four kinds of message are not threaded at all: they are answers to something the user has to act on.
    for (const type of ["auto-review-approval", "local-tool-permission", "email-draft", "slack-draft"]) {
      assert.deepEqual(withReplyTo({ type, keep: true } as never, "entry-0"), { type, keep: true });
      assert.deepEqual(stripReplyTo({ type, keep: true, reply_to: "entry-0" } as never), { type, keep: true, reply_to: "entry-0" });
    }
  });

  it("summarizes a prompt the user could skip, and nothing else", () => {
    assert.equal(skippablePromptSummary({ type: "widget", widget: { prompt: "Keep?", options: [{ label: "Yes", value: "y" }] } }), "Keep? — Yes");
    assert.equal(skippablePromptSummary({ type: "text", content: "x" }), undefined);
  });

  it("sorts the files an attachment may name by what they are", () => {
    assert.deepEqual(splitAttachmentPathsByChannel(["a.png", "b.mp4", "c.pdf", "d.txt"]), { imageAttachmentPaths: ["a.png"], videoAttachmentPaths: ["b.mp4"], fileAttachmentPaths: ["c.pdf", "d.txt"] });
    // A video the platform can name carries its own type and the frame rate the platform takes; one it cannot is
    // taken as the ordinary container.
    assert.deepEqual(buildSelectedVideos(["/tmp/clip.mov", "/tmp/unknown.zzz"]), [
      { path: "/tmp/clip.mov", mimeType: "video/quicktime", filename: "clip.mov", fps: 4 },
      { path: "/tmp/unknown.zzz", mimeType: "video/mp4", filename: "unknown.zzz", fps: 4 },
    ]);
    // What arrived with a message is carried as it came, and what is not there is not invented.
    assert.deepEqual(collectInboundImages([{ images: [{ data: "a", mimeType: "image/png" }] }, {}, { images: [{ data: "b", mimeType: "image/jpeg" }] }]), [{ data: "a", mimeType: "image/png" }, { data: "b", mimeType: "image/jpeg" }]);
  });

  it("measures the files it can measure, and forgets the ones it cannot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "slate-attachment-sizes-"));
    const file = join(directory, "notes.txt");
    writeFileSync(file, "12345", "utf8");
    mkdirSync(join(directory, "a-directory"));
    const sizes = await statAttachedFileSizes([file, join(directory, "missing.txt"), join(directory, "a-directory")]);
    assert.deepEqual([...sizes.entries()], [[file, 5]]);
  });
});
