import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectImageMimeType } from "../../source/packages/agent/tools/core/read/image-utils.ts";

describe("image media-type detection contract", () => {
  it("uses byte signatures before a filename hint", () => {
    assert.equal(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]), "diagram.png"), "image/jpeg");
  });

  it("uses a recognized image filename when the bytes do not identify a format", () => {
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "/workspace/preview.webp"), "image/webp");
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "/workspace/vector.svg"), "image/svg+xml");
  });

  it("keeps less common image suffixes available as a final fallback", () => {
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "photo.AVIF"), "image/avif");
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "photo.HEIC"), "image/heic");
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "photo.HEIF"), "image/heif");
  });

  it("does not treat arbitrary MIME types or missing hints as images", () => {
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3]), "/workspace/readme.txt"), undefined);
    assert.equal(detectImageMimeType(new Uint8Array([0, 1, 2, 3])), undefined);
  });
});
