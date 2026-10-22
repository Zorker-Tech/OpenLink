import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import * as shaping from "../../source/host/transcript/send-message-shaping.ts";

const userEntry = { kind: "message", id: "m-1", role: "user", content: "  hello   world  " };
const sendEntry = (message: unknown) => ({ kind: "send-message", id: "s-1", message });

describe("what a sent message becomes in the conversation", () => {
  it("tells a user entry from the agent's, and quotes only text", () => {
    assert.equal(shaping.isUserMessageEntry(userEntry as never), true);
    assert.equal(shaping.isUserMessageEntry({ kind: "message", role: "assistant", content: "a" } as never), false);
    assert.equal(shaping.isUserMessageEntry({ kind: "user-attachment", id: "a" } as never), true);
    assert.equal(shaping.isUserMessageEntry({ kind: "tool-call", id: "t" } as never), false);
    assert.equal(shaping.quotableEntryText(userEntry as never), "  hello   world  ");
    assert.equal(shaping.quotableEntryText(sendEntry({ type: "text", content: "sent" }) as never), "sent");
    assert.equal(shaping.quotableEntryText(sendEntry({ type: "widget", widget: {} }) as never), "");
    assert.equal(shaping.quotableEntryText({ kind: "message", role: "user", content: {} } as never), "");
  });

  it("quotes a message on one line, falling back to its id and cutting at a length", () => {
    assert.equal(shaping.describeMessageQuote(userEntry as never), "hello world");
    assert.equal(shaping.describeMessageQuote({ kind: "message", id: "m-2", role: "user", content: "   " } as never), "m-2");
    assert.equal(shaping.describeMessageQuote(sendEntry({ type: "text", content: "abcdef" }) as never, 3), "abc…");
    assert.equal(shaping.describeMessageQuote(sendEntry({ type: "text", content: "abc" }) as never, 3), "abc", "an exact fit is not cut");
    assert.equal(shaping.describeReactedMessageQuote(sendEntry({ type: "text", content: "x".repeat(81) }) as never).length, 81);
    assert.equal(shaping.describeRepliedMessageQuote(sendEntry({ type: "text", content: "x".repeat(81) }) as never), "x".repeat(81));
  });

  it("toggles a reaction, and drops the list when it empties", () => {
    assert.deepEqual(shaping.toggleReaction(undefined, "👍", "alice"), [{ emoji: "👍", by: "alice" }]);
    assert.deepEqual(shaping.toggleReaction([{ emoji: "👍", by: "alice" }], "👍", "alice"), undefined);
    assert.deepEqual(
      shaping.toggleReaction([{ emoji: "👍", by: "alice" }, { emoji: "🔥", by: "bob" }], "🔥", "alice"),
      [{ emoji: "👍", by: "alice" }, { emoji: "🔥", by: "bob" }, { emoji: "🔥", by: "alice" }],
    );
  });

  it("notes when a message was composed offline, and builds user messages with the options given", () => {
    assert.equal(shaping.buildComposedOfflineNote(1_700_000_000_000), "[Composed offline at 2023-11-14T22:13:20.000Z]");
    assert.equal(shaping.buildComposedOfflineNote(Number.NaN), "");
    const plain = shaping.createUserMessage("id-1", "content") as Record<string, unknown>;
    assert.equal(plain.kind, "message");
    assert.equal(plain.role, "user");
    assert.equal(plain.content, "content");
    assert.equal(plain.isStreaming, false);
    assert.equal(typeof plain.timestampMs, "number");
    assert.deepEqual(Object.keys(plain).sort(), ["content", "id", "isStreaming", "kind", "richText", "role", "timestampMs"].sort());
    const full = shaping.createUserMessage("id-2", "content", {
      composedAtMs: 1_700_000_000_000,
      richText: "rich",
      replyTo: "r",
      batchId: "b",
      branched: true,
      clientNonce: "n",
    }) as Record<string, unknown>;
    assert.deepEqual(full, {
      kind: "message",
      id: "id-2",
      role: "user",
      content: "content",
      richText: "rich",
      isStreaming: false,
      timestampMs: 1_700_000_000_000,
      replyTo: "r",
      batchId: "b",
      branched: true,
      clientNonce: "n",
      sentWhileOfflineAtMs: 1_700_000_000_000,
    });
    assert.equal((shaping.createUserMessage("id-3", "c", { composedAtMs: Number.NaN }) as Record<string, unknown>).sentWhileOfflineAtMs, undefined, "a nonsensical time is not composed offline");
  });

  it("threads only the message types that can be threaded, keeping their fields", () => {
    const text = shaping.withReplyTo({ type: "text", content: "hi", images: ["i"] } as never, "target") as Record<string, unknown>;
    assert.deepEqual(Object.keys(text), ["type", "content", "images", "reply_to"]);
    assert.equal(text.reply_to, "target");
    const connector = shaping.withReplyTo({ type: "connector", connector: {}, variant: "v", serverId: "s" } as never, "t") as Record<string, unknown>;
    assert.deepEqual(Object.keys(connector), ["type", "connector", "variant", "reply_to", "serverId"]);
    const stripped = shaping.stripReplyTo({ type: "attachment", url: "u", reply_to: "r", alt: "a" } as never) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stripped), ["type", "url", "alt"]);
    const email = { type: "email-draft", reply_to: "r" };
    assert.equal(shaping.stripReplyTo(email as never), email, "a draft is returned as it came");
    assert.equal(shaping.withReplyTo(email as never, "t"), email);
    const unknown = { type: "unknown", extra: 1 };
    assert.equal(shaping.stripReplyTo(unknown as never), unknown);
    assert.equal(shaping.skippablePromptSummary({ type: "text" } as never), undefined);
  });

  it("builds an attachment entry from a measured file", async () => {
    const reader = { async readImageDimensions() { return { width: 10, height: 20 }; } };
    const entry = await shaping.createUserAttachmentEntry(reader, "att-1", "/tmp/a.png", { fileName: "  a.png  ", batchId: "b", replyTo: "r" }) as Record<string, unknown>;
    assert.deepEqual(entry, {
      kind: "user-attachment",
      id: "att-1",
      file_path: "/tmp/a.png",
      file_name: "a.png",
      batchId: "b",
      width: 10,
      height: 20,
      byteSize: undefined,
      replyTo: "r",
    });
    const noDimensions = await shaping.createUserAttachmentEntry({ async readImageDimensions() { return null; } }, "att-2", "/tmp/b.bin") as Record<string, unknown>;
    assert.equal(noDimensions.width, undefined);
    assert.equal(noDimensions.height, undefined);
  });

  it("splits attachment paths by channel and measures the files that are there", async () => {
    assert.deepEqual(shaping.splitAttachmentPathsByChannel(["/x/a.png", "/x/b.mp4", "/x/c.txt", "/x/d.webm"]), {
      imageAttachmentPaths: ["/x/a.png"],
      videoAttachmentPaths: ["/x/b.mp4", "/x/d.webm"],
      fileAttachmentPaths: ["/x/c.txt"],
    });
    assert.deepEqual(shaping.buildSelectedVideos(["/x/b.mp4", "/x/c.weird"]), [
      { path: "/x/b.mp4", mimeType: "video/mp4", filename: "b.mp4", fps: 4 },
      { path: "/x/c.weird", mimeType: "video/mp4", filename: "c.weird", fps: 4 },
    ]);
    const root = fs.mkdtempSync(path.join("/tmp", "shaping-test-"));
    try {
      const file = path.join(root, "a.txt");
      fs.writeFileSync(file, "abc");
      const directory = path.join(root, "dir");
      fs.mkdirSync(directory);
      const sizes = await shaping.statAttachedFileSizes([file, directory, path.join(root, "missing")]);
      assert.deepEqual([...sizes.entries()], [[file, 3]]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});