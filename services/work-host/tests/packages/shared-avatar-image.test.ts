import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as avatar from "../../source/shared/media/avatar-image.ts";
import {
  AVATAR_EXTENSION_MIME,
  AVATAR_SOURCE_MAX_BYTES,
  avatarMimeHintForExtension,
  avatarSourceSizeError,
} from "../../source/shared/media/avatar-image.ts";

describe("an avatar's source image", () => {
  it("may be up to 25 MB, and the notice says how much that is", () => {
    assert.equal(AVATAR_SOURCE_MAX_BYTES, 25 * 1024 * 1024);
    assert.equal(avatarSourceSizeError(0), null);
    assert.equal(avatarSourceSizeError(AVATAR_SOURCE_MAX_BYTES - 1), null);
    assert.equal(avatarSourceSizeError(AVATAR_SOURCE_MAX_BYTES), null, "the limit itself is not over it");
    assert.equal(avatarSourceSizeError(AVATAR_SOURCE_MAX_BYTES + 1), "Choose an image smaller than 25 MB.");
  });

  it("is named as an image by its extension, in the order the extensions are offered", () => {
    assert.deepEqual([...AVATAR_EXTENSION_MIME.entries()], [
      [".png", "image/png"],
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".webp", "image/webp"],
      [".gif", "image/gif"],
      [".bmp", "image/bmp"],
      [".avif", "image/avif"],
      [".svg", "image/svg+xml"],
    ]);
    for (const [extension, mimeType] of AVATAR_EXTENSION_MIME) {
      assert.equal(avatarMimeHintForExtension(extension), mimeType, extension);
    }
  });

  it("compares the extension without case, and does not guess at one it does not know", () => {
    assert.equal(avatarMimeHintForExtension(".PNG"), "image/png");
    assert.equal(avatarMimeHintForExtension(".JpEg"), "image/jpeg");
    assert.equal(avatarMimeHintForExtension(".Svg"), "image/svg+xml");
    // The extension is expected with its dot: a bare file name is not an extension this platform knows.
    assert.equal(avatarMimeHintForExtension("png"), "application/octet-stream");
    assert.equal(avatarMimeHintForExtension(""), "application/octet-stream");
    assert.equal(avatarMimeHintForExtension(".tiff"), "application/octet-stream");
  });

  it("exposes the limit, the table and the two readers, and nothing else at runtime", () => {
    assert.deepEqual(Object.keys(avatar).sort(), [
      "AVATAR_EXTENSION_MIME",
      "AVATAR_SOURCE_MAX_BYTES",
      "avatarMimeHintForExtension",
      "avatarSourceSizeError",
    ]);
    assert.equal(AVATAR_EXTENSION_MIME instanceof Map, true);
  });
});
