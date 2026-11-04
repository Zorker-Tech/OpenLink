import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_INLINE_IMAGES_PER_ENTRY,
  normalizeInlineImages,
  normalizeMirrorEntry,
  normalizeTurnMessages,
} from "../../source/host/rooms/xuser-wire-normalization.ts";

describe("shared-room wire normalization", () => {
  it("caps images before validation and normalizes media types and optional alt text", () => {
    assert.deepEqual(normalizeInlineImages("not an array"), []);
    const images = normalizeInlineImages([
      { base64: "a", mediaType: "text/plain", alt: "" },
      { base64: "b", mediaType: "image/webp", alt: "chart" },
      { base64: "c", mediaType: "image/png" },
      { base64: "d", mediaType: "image/png" },
      { base64: "beyond-cap", mediaType: "image/png" },
    ]);
    assert.equal(MAX_INLINE_IMAGES_PER_ENTRY, 4);
    assert.deepEqual(images, [
      { base64: "a", mediaType: "image/png" },
      { base64: "b", mediaType: "image/webp", alt: "chart" },
      { base64: "c", mediaType: "image/png" },
      { base64: "d", mediaType: "image/png" },
    ]);
    assert.deepEqual(normalizeInlineImages([null, { base64: "" }, { base64: "ok" }]), [{ base64: "ok", mediaType: "image/png" }]);
  });

  it("requires a valid human identity, clamps its name, and accepts image-only content", () => {
    assert.equal(normalizeMirrorEntry(null, 55), null);
    assert.equal(normalizeMirrorEntry({ kind: "human-message", entryId: "e1", text: "hello" }, 55), null);
    assert.equal(normalizeMirrorEntry({ kind: "human-message", entryId: "e1", authorAuthId: "owner", text: "", images: [] }, 55), null);

    const entry = normalizeMirrorEntry({
      kind: "human-message",
      entryId: "e2",
      authorAuthId: "owner",
      authorName: ` ${"x".repeat(130)} `,
      authorAvatarUrl: "",
      clientNonce: "nonce-1",
      timestampMs: Number.POSITIVE_INFINITY,
      text: "",
      images: [{ base64: "payload" }],
    }, 99);
    assert.notEqual(entry, null);
    assert.equal(entry?.kind, "human-message");
    assert.equal(entry?.authorName.length, 120);
    assert.equal(entry?.timestampMs, 99);
    assert.equal(entry?.authorAvatarUrl, undefined);
    assert.equal(entry?.clientNonce, "nonce-1");
    assert.deepEqual(entry?.images, [{ base64: "payload", mediaType: "image/png" }]);
  });

  it("requires both agent owner ids and keeps only its documented fields", () => {
    assert.equal(normalizeMirrorEntry({ kind: "agent-message", entryId: "e1", agentOwnerAuthId: "owner", text: "hi" }, 1), null);
    assert.equal(normalizeMirrorEntry({ kind: "future", entryId: "e1", text: "hi" }, 1), null);
    assert.deepEqual(normalizeMirrorEntry({
      kind: "agent-message",
      entryId: "e2",
      agentOwnerAuthId: "owner",
      agentId: "agent-1",
      authorName: " Agent ",
      text: "hello",
      images: [],
      timestampMs: 42,
      clientNonce: "ignored",
    }, 100), {
      kind: "agent-message",
      entryId: "e2",
      agentOwnerAuthId: "owner",
      agentId: "agent-1",
      authorName: "Agent",
      text: "hello",
      images: [],
      timestampMs: 42,
    });
  });

  it("filters invalid turn rows, defaults unknown speakers to human, and caps the list", () => {
    const mixed = normalizeTurnMessages([
      null,
      { speakerKind: "agent", speakerName: " Agent ", text: "  keep whitespace  ", isSelf: true },
      { speakerKind: "future", speakerName: "Guest", text: "hello", isSelf: "true" },
      { speakerKind: "human", speakerName: "empty", text: "" },
    ]);
    assert.deepEqual(mixed, [
      { speakerKind: "agent", speakerName: "Agent", isSelf: true, text: "  keep whitespace  " },
      { speakerKind: "human", speakerName: "Guest", text: "hello" },
    ]);
    const capped = normalizeTurnMessages(Array.from({ length: 25 }, (_unused, index) => ({
      speakerKind: "human",
      speakerName: `user-${index}`,
      text: `m-${index}`,
    })));
    assert.equal(capped.length, 24);
    assert.equal(capped.at(-1)?.text, "m-23");
  });
});
