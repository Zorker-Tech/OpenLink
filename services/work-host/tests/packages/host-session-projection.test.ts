import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as projection from "../../source/host/extensions/session/session-projection.ts";
import {
  buildAttachmentLastEntry,
  collectLastAttachmentBatchKinds,
  getLastEntryFromTranscript,
  getLastMessageFromTranscript,
  getSummaryUpdatedAt,
  getUpdatedAtFromStats,
  isHttpsUrl,
  isLinkAttachmentMessage,
  lastMessagePreviewText,
  seedActivityFromMtime,
} from "../../source/host/extensions/session/session-projection.ts";

const row = (fields: Record<string, unknown>): Record<string, unknown> => ({ ...fields });

describe("the dates a session projects", () => {
  it("take the later of creation and the transcript's own file time", () => {
    assert.equal(getUpdatedAtFromStats({ createdAt: 12 }, { mtimeMs: 9.7 }), 12);
    assert.equal(getUpdatedAtFromStats({ createdAt: 5 }, { mtimeMs: 9.7 }), 9, "the file time is floored");
    assert.equal(getUpdatedAtFromStats({ createdAt: 12 }), 12, "no file time is zero");
    assert.equal(Number.isNaN(getUpdatedAtFromStats({ createdAt: 12 }, { mtimeMs: Number.NaN })), true, "a NaN file time poisons the answer, as Math.max does");
  });

  it("take the later of creation and the last activity for a summary", () => {
    assert.equal(getSummaryUpdatedAt({ createdAt: 4 }, { lastActivityAt: 8 }), 8);
    assert.equal(getSummaryUpdatedAt({ createdAt: 9 }, { lastActivityAt: 8 }), 9);
  });
});

describe("seeding a session's activity", () => {
  const drive = (unread: { lastActivityAt: number }, root: unknown, createdAt: unknown = 77): number[] => {
    const calls: number[] = [];
    seedActivityFromMtime(
      {
        getUnreadState: () => unread,
        get: (key: string) => (key === "latestRootBlobId" ? root : key === "createdAt" ? createdAt : undefined),
        markActivity: (at: number) => calls.push(at),
      } as never,
      "agent-1",
      { mtimeMs: 50 },
    );
    return calls;
  };

  it("is seeded from the file time once, only when nothing marked activity yet and a root blob exists", () => {
    assert.deepEqual(drive({ lastActivityAt: 0 }, new Uint8Array([1])), [77]);
    assert.deepEqual(drive({ lastActivityAt: 0 }, new Uint8Array([1]), 10), [50], "the later of the creation date and the file time");
    assert.deepEqual(drive({ lastActivityAt: 0 }, new Uint8Array([1]), 60), [60]);
    assert.deepEqual(drive({ lastActivityAt: 3 }, new Uint8Array([1])), [], "activity already marked is left alone");
    assert.deepEqual(drive({ lastActivityAt: 0 }, undefined), [], "no root blob, no activity");
    assert.deepEqual(drive({ lastActivityAt: 0 }, new Uint8Array([])), [], "an empty root blob is no blob");
    assert.deepEqual(drive({ lastActivityAt: 0 }, 7), [], "a numeric root is not a blob");
  });
});

describe("what an attachment is", () => {
  it("is a link when it is an https url with no file name of the user's", () => {
    assert.equal(isHttpsUrl("https://host/a.png"), true);
    assert.equal(isHttpsUrl("HTTPS://host/a.png"), true);
    assert.equal(isHttpsUrl("http://host/a.png"), false);
    assert.equal(isHttpsUrl("not a url"), false);
    assert.equal(isLinkAttachmentMessage({ type: "attachment", url: "https://host/a.png" }), true);
    assert.equal(isLinkAttachmentMessage({ type: "attachment", url: "https://host/a.png", file_name: "a.png" }), false);
    assert.equal(isLinkAttachmentMessage({ type: "attachment", url: "https://host/a.png", file_name: "" }), true, "an empty name is no name");
    assert.equal(isLinkAttachmentMessage({ type: "text", url: "https://host/a.png" }), false);
  });

  it("is classified by the extension at the end of its name or path, as one of five kinds", () => {
    const kindOf = (name: string): string[] =>
      Object.keys(buildAttachmentLastEntry([row({ kind: "user-attachment", file_path: name })], 0).kinds as Record<string, number>);
    assert.deepEqual(kindOf("a.png"), ["image"]);
    assert.deepEqual(kindOf("a.JPEG?x=1"), ["image"]);
    assert.deepEqual(kindOf("a.mp4"), ["video"]);
    assert.deepEqual(kindOf("a.mp3"), ["audio"]);
    assert.deepEqual(kindOf("a.docx"), ["document"]);
    assert.deepEqual(kindOf("a.bin"), ["other"]);
    // The kind is read from the end of the text, not from anywhere in it.
    assert.deepEqual(kindOf("/w/a.png"), ["image"]);
    assert.deepEqual(kindOf("/w/a.png/b.mp4"), ["video"], "the extension that counts is the one the text ends with");
    // The name and the path are read as one text; a name with nothing beside it ends in the word "undefined", so it is other.
    assert.deepEqual(Object.keys(buildAttachmentLastEntry([row({ kind: "user-attachment", file_name: "a.png" })], 0).kinds as Record<string, number>), ["other"]);
  });
});

describe("an attachment batch ending at an entry", () => {
  it("walks back over the same batch, and the kinds come back oldest first", () => {
    const rows = [
      row({ kind: "user-attachment", batchId: "b1", file_name: "a.png", file_path: "/w/a.png" }),
      row({ kind: "user-attachment", batchId: "b1", file_name: "b.mp4", file_path: "/w/b.mp4" }),
    ];
    assert.deepEqual(collectLastAttachmentBatchKinds(rows, 1), ["image", "video"]);
    // A different batch id ends the walk, and so does another kind of entry.
    assert.deepEqual(collectLastAttachmentBatchKinds([row({ kind: "user-attachment", batchId: "b1", file_name: "a.png", file_path: "/w/a.png" }), row({ kind: "user-attachment", batchId: "b2", file_name: "b.mp4", file_path: "/w/b.mp4" })], 1), ["video"]);
    assert.deepEqual(collectLastAttachmentBatchKinds([row({ kind: "user-attachment", file_name: "a.png", file_path: "/w/a.png" }), row({ kind: "user-attachment", file_name: "b.mp4", file_path: "/w/b.mp4" })], 1), ["video"], "no batch id on the last entry means no earlier entry can be in its batch");
    assert.deepEqual(collectLastAttachmentBatchKinds([row({ kind: "message", content: "x" }), row({ kind: "user-attachment", file_name: "b.mp4", file_path: "/w/b.mp4" })], 1), ["video"]);

    // The last entry is what the batch is ended by: an attachment sent as a message works the same way, unless it is a link.
    const sent = [row({ kind: "send-message", batchId: "b", message: { type: "attachment", url: "file:///a.pdf", file_name: "a.pdf" } })];
    assert.deepEqual(collectLastAttachmentBatchKinds(sent, 0), ["document"]);
    assert.deepEqual(collectLastAttachmentBatchKinds([row({ kind: "send-message", message: { type: "attachment", url: "https://host/a.png" } })], 0), [], "a link is not a batch");
  });

  it("becomes an attachment last-entry with the count and the kinds", () => {
    const rows = [
      row({ kind: "user-attachment", batchId: "b", file_name: "a.png", file_path: "/w/a.png" }),
      row({ kind: "user-attachment", batchId: "b", file_name: "b.png", file_path: "/w/b.png" }),
      row({ kind: "user-attachment", batchId: "b", file_name: "c.mp4", file_path: "/w/c.mp4" }),
    ];
    assert.deepEqual(buildAttachmentLastEntry(rows, 2), { kind: "attachment", count: 3, kinds: { image: 2, video: 1 } });
    assert.deepEqual(buildAttachmentLastEntry(rows, 5), { kind: "attachment", count: 0, kinds: {} });
  });
});

describe("a message preview", () => {
  it("is one line, without markdown markers, at most 280 characters", () => {
    assert.equal(lastMessagePreviewText({ type: "text", content: "  a   b\nc " }), "a b c");
    assert.equal(lastMessagePreviewText({ type: "text", content: "*bold* _it_ `code` #tag > quote" }), "bold it code tag  quote", "markers are removed after whitespace is collapsed, so the gap they leave stays");
    assert.equal(lastMessagePreviewText({ type: "text", content: "x".repeat(300) }).length, 280);
    assert.equal(lastMessagePreviewText({ type: "text", content: "😀".repeat(200) }).length, 280);
    assert.equal(lastMessagePreviewText({ type: "text", content: 42 }), "42");
    assert.equal(lastMessagePreviewText({ type: "text" }), "");
  });

  it("is by what the message is: a text, a link, an attachment, a title, a label or its type", () => {
    assert.equal(lastMessagePreviewText({ type: "attachment", url: "https://host/a.png" }), "Sent a link · https://host/a.png");
    assert.equal(lastMessagePreviewText({ type: "attachment", url: "file:///a.mp4" }), "Sent an attachment · video");
    assert.equal(lastMessagePreviewText({ type: "other", title: "Titled" }), "Titled");
    assert.equal(lastMessagePreviewText({ type: "other", label: "Labelled" }), "Labelled");
    assert.equal(lastMessagePreviewText({ type: "plan" }), "plan");
  });
});

describe("the last thing a transcript shows", () => {
  it("finds the newest send-message and its preview, hidden or not", () => {
    const rows = [
      row({ kind: "send-message", id: "e1", message: { type: "text", content: "first" } }),
      row({ kind: "send-message", id: "e2", message: { type: "text", content: "second" } }),
    ];
    assert.deepEqual(getLastMessageFromTranscript(rows), { id: "e2", preview: "second" });
    // This one does not filter: a hidden message is still the newest message.
    assert.deepEqual(getLastMessageFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "text", content: "hi" } }), row({ kind: "send-message", id: "e2", hidden: true, message: { type: "text", content: "hidden" } })]), { id: "e2", preview: "hidden" });
    assert.equal(getLastMessageFromTranscript([row({ kind: "message", content: "x" })]), null);
    assert.equal(getLastMessageFromTranscript([]), null);
  });

  it("skips hidden, branched and peer entries for the last row", () => {
    const base = [
      row({ kind: "send-message", id: "e1", message: { type: "text", content: "shown text" } }),
      row({ kind: "send-message", id: "e2", hidden: true, message: { type: "text", content: "hidden" } }),
      row({ kind: "send-message", id: "e3", branched: true, message: { type: "text", content: "branched" } }),
      row({ kind: "send-message", id: "e4", peerAgentId: "other", message: { type: "text", content: "peer" } }),
    ];
    assert.deepEqual(getLastEntryFromTranscript(base), { kind: "text", text: "shown text" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "message", content: "a message" })]), { kind: "text", text: "a message" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "message", content: "" })]), null, "an empty message kind has nothing to show");
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "user-attachment", file_name: "a.png", file_path: "/w/a.png" })]), { kind: "attachment", count: 1, kinds: { image: 1 } });
    assert.equal(getLastEntryFromTranscript([]), null);
  });

  it("shows a widget's question with its answer, and a link as a link", () => {
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "widget", widget: { prompt: "Pick one" } } })]), { kind: "text", text: "Pick one" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", respondedValue: "A", message: { type: "widget", widget: { prompt: "Pick one" } } })]), { kind: "text", text: "Pick one — A" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "widget" } })]), { kind: "text", text: "Question" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "attachment", url: "https://host/a.png" } })]), { kind: "link", url: "https://host/a.png" });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "attachment", url: "file:///a.png", file_name: "a.png" } })]), { kind: "attachment", count: 1, kinds: { image: 1 } });
    assert.deepEqual(getLastEntryFromTranscript([row({ kind: "send-message", id: "e1", message: { type: "plan", content: "the plan" } })]), { kind: "text", text: "plan" });
  });
});