/**
 * An attachment that came in through a channel: which addresses are passed on, which paths are read, and what a
 * sender's file is allowed to be.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES, GENERIC_BINARY_MIME, resolveChannelAttachment, toLocalChannelAttachmentPath, urlLooksLikeImage } from "../../source/host/connectors/channel-attachment.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-channel-attachment-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const file = (name: string, contents: string | Uint8Array) => {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  return path;
};

describe("an attachment that arrived through a channel", () => {
  it("passes an http address on as it is, and says whether the address looks like an image", async () => {
    assert.deepEqual(await resolveChannelAttachment("https://example.test/photo.png"), { transport: "url", isImage: true, url: "https://example.test/photo.png" });
    assert.deepEqual(await resolveChannelAttachment("http://example.test/notes.txt"), { transport: "url", isImage: false, url: "http://example.test/notes.txt" });
    assert.deepEqual([urlLooksLikeImage("https://example.test/a.jpeg"), urlLooksLikeImage("https://example.test/a.txt"), urlLooksLikeImage("not a url")], [true, false, false]);
    // What matters is the path, not the query a link may carry.
    assert.deepEqual([urlLooksLikeImage("https://example.test/photo.png?v=2"), urlLooksLikeImage("https://example.test/photo?file=shot.png")], [true, false]);
  });

  it("reads a file the channel pointed at, naming its type from what the file is called", async () => {
    const png = file("photo.png", "png-bytes");
    const uploaded = await resolveChannelAttachment(`file://${png}`, { reanchor: (path) => path });
    assert.deepEqual(uploaded, { transport: "upload", isImage: true, bytes: new TextEncoder().encode("png-bytes"), filename: "photo.png", mime: "image/png" });
    const video = file("clip.mp4", "video-bytes");
    assert.deepEqual((await resolveChannelAttachment(`file://${video}`, { reanchor: (path) => path })) as never, { transport: "upload", isImage: false, bytes: new TextEncoder().encode("video-bytes"), filename: "clip.mp4", mime: "video/mp4" });
    const unknown = file("notes.txt", "text");
    assert.equal(((await resolveChannelAttachment(`file://${unknown}`, { reanchor: (path) => path })) as { mime: string }).mime, GENERIC_BINARY_MIME);
    // A plain path is a path too, and is re-anchored before anything is read.
    const anchored = file("anchored.png", "x");
    const calls: string[] = [];
    const plain = await resolveChannelAttachment(anchored, { reanchor: (path) => (calls.push(path), path) });
    assert.deepEqual([calls, (plain as { filename: string }).filename], [[anchored], "anchored.png"]);
  });

  it("answers nothing for what it may not read: missing, a directory, empty, too large, unreadable, or not a file at all", async () => {
    const directory = join(scratch, "a-directory.png");
    mkdirSync(directory, { recursive: true });
    const empty = file("empty.png", "");
    const large = file("large.bin", "x");
    const unreadable = file("unreadable.png", "x");
    const answers = await Promise.all([
      resolveChannelAttachment(`file://${join(scratch, "not-here.png")}`, { reanchor: (path) => path }),
      resolveChannelAttachment(`file://${directory}`, { reanchor: (path) => path }),
      resolveChannelAttachment(`file://${empty}`, { reanchor: (path) => path }),
      resolveChannelAttachment(`file://${large}`, { reanchor: (path) => path, stat: (async () => ({ isFile: () => true, size: CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES + 1 })) as never }),
      resolveChannelAttachment(`file://${unreadable}`, { reanchor: (path) => path, readFile: (async () => { throw new Error("gone"); }) as never }),
      resolveChannelAttachment("s3://bucket/key.png"),
      resolveChannelAttachment(""),
      resolveChannelAttachment(42),
      resolveChannelAttachment(null),
    ]);
    assert.deepEqual(answers, [null, null, null, null, null, null, null, null, null]);
    // The largest file the platform will send is still sent.
    const boundary = await resolveChannelAttachment(`file://${large}`, { reanchor: (path) => path, stat: (async () => ({ isFile: () => true, size: CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES })) as never });
    assert.equal((boundary as { transport: string }).transport, "upload");
  });

  it("turns an address into a path only when it is one this machine can read", () => {
    assert.equal(toLocalChannelAttachmentPath("file:///tmp/a.png"), "/tmp/a.png");
    assert.equal(toLocalChannelAttachmentPath("/tmp/a.png"), "/tmp/a.png");
    assert.deepEqual([toLocalChannelAttachmentPath("https://example.test/a.png"), toLocalChannelAttachmentPath("s3://b/k"), toLocalChannelAttachmentPath("")], [null, null, null]);
  });
});
