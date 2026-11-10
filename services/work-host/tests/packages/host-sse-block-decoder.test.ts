import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SseBlockDecoder } from "../../source/coordinator/gateway/sse-block-decoder.ts";

/** The blocks a stream of chunks produces. */
function decode(chunks: readonly string[]): string[] {
  const blocks: string[] = [];
  const decoder = new SseBlockDecoder((block) => blocks.push(block));
  const encoder = new TextEncoder();
  for (const chunk of chunks) decoder.push(encoder.encode(chunk));
  return blocks;
}

describe("the blocks a server sends over one connection", () => {
  it("hands over each block as soon as it is whole", () => {
    assert.deepEqual(decode(["data: one\n\ndata: two\n\n"]), ["data: one", "data: two"]);
    assert.deepEqual(decode(["data: one\n\n", "data: two\n\n"]), ["data: one", "data: two"]);
  });

  it("holds a block that arrived in pieces until the rest arrives", () => {
    assert.deepEqual(decode(["da", "ta: split\n", "\n"]), ["data: split"]);
    assert.deepEqual(decode(["data: one\n", "\ndata: two\n\n"]), ["data: one", "data: two"]);
  });

  it("joins what it held with the piece that finishes the block", () => {
    assert.deepEqual(decode(["data: a\n", "b\n\n"]), ["data: a\nb"]);
    assert.deepEqual(decode(["da", "ta: x\n", "y\n\n"]), ["data: x\ny"]);
  });

  it("holds a block that has not ended yet", () => {
    assert.deepEqual(decode(["data: a\n\ndata: b"]), ["data: a"]);
    assert.deepEqual(decode([]), []);
    assert.deepEqual(decode([""]), []);
  });

  it("does not treat the two line feeds of one separator as a block of their own", () => {
    // Pinned as it behaves: a separator that opens a chunk with no block before it ends the held block, and the
    // empty piece before it is handed over as a block of its own.
    assert.deepEqual(decode(["data: a\n\n\n"]), ["data: a"]);
    assert.deepEqual(decode(["\n\ndata: a\n\n"]), ["", "data: a"]);
    assert.deepEqual(decode(["x\n\n", "\n\ny\n\n"]), ["x", "", "y"]);
  });

  it("splits only on line feeds, so a block written with carriage returns is not a block", () => {
    assert.deepEqual(decode(["data: one\r\n\r\n"]), [], "\r\n\r\n is not the separator this reads");
    assert.deepEqual(decode(["data: one\n\r\n"]), [], "a carriage return between the two line feeds is not a separator either");
  });
});
