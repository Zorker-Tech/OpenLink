import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sha256Hex } from "../../source/host/sha256.ts";

describe("the digest files are stored under", () => {
  it("is the sha256 of the content, in hex", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex("é ü 工具 💾").length, 64);
  });

  it("digests buffers and typed arrays as their bytes", () => {
    assert.equal(sha256Hex(Buffer.from("abc")), sha256Hex("abc"));
    assert.equal(sha256Hex(new Uint8Array([1, 2, 3])).length, 64);
    assert.notEqual(sha256Hex(new Uint8Array([1, 2, 3])), sha256Hex(new Uint8Array([1, 2, 4])));
  });
});
