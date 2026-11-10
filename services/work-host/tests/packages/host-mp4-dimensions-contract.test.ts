import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Mp4Dimensions } from "../../source/shared/media/video-dimensions.ts";

type BoxSizeMode = "normal" | "extended" | "zero";

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, false);
}

function box(type: string, payload: Uint8Array, mode: BoxSizeMode = "normal"): Uint8Array {
  const headerSize = mode === "extended" ? 16 : 8;
  const output = new Uint8Array(headerSize + payload.length);
  if (mode === "normal") writeU32(output, 0, output.length);
  else if (mode === "extended") {
    writeU32(output, 0, 1);
    writeU32(output, 12, output.length);
  }
  for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index);
  output.set(payload, headerSize);
  return output;
}

function trackHeader(width: number, height: number, options: { version?: number; quarterTurn?: boolean } = {}): Uint8Array {
  const version = options.version ?? 0;
  const matrixStart = 40 + (version === 1 ? 12 : 0);
  const widthStart = matrixStart + 36;
  const payload = new Uint8Array(widthStart + 8);
  payload[0] = version;
  if (options.quarterTurn === true) {
    writeU32(payload, matrixStart, 0);
    writeU32(payload, matrixStart + 4, 65_536);
    writeU32(payload, matrixStart + 12, 0xffff_0000);
    writeU32(payload, matrixStart + 16, 0);
  } else {
    writeU32(payload, matrixStart, 65_536);
    writeU32(payload, matrixStart + 4, 0);
    writeU32(payload, matrixStart + 12, 0);
    writeU32(payload, matrixStart + 16, 65_536);
  }
  writeU32(payload, widthStart, width * 65_536);
  writeU32(payload, widthStart + 4, height * 65_536);
  return payload;
}

function movie(
  width: number,
  height: number,
  options: { version?: number; quarterTurn?: boolean; moovMode?: BoxSizeMode; tkhdMode?: BoxSizeMode } = {},
): Uint8Array {
  const tkhd = box("tkhd", trackHeader(width, height, options), options.tkhdMode);
  const track = box("trak", tkhd);
  const moov = box("moov", track, options.moovMode);
  return concat(box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d])), moov);
}

function malformedMoov(): Uint8Array {
  const bytes = new Uint8Array(12);
  writeU32(bytes, 0, 4);
  for (let index = 0; index < 4; index += 1) bytes[4 + index] = "moov".charCodeAt(index);
  return bytes;
}

describe("MP4 video dimensions", () => {
  it("reads integer dimensions from the movie track header", () => {
    assert.deepEqual(Mp4Dimensions.read(movie(640, 360)), { width: 640, height: 360 });
  });

  it("reads both version-zero and version-one track header offsets", () => {
    assert.deepEqual(Mp4Dimensions.read(movie(1280, 720, { version: 0 })), { width: 1280, height: 720 });
    assert.deepEqual(Mp4Dimensions.read(movie(1920, 1080, { version: 1 })), { width: 1920, height: 1080 });
  });

  it("swaps dimensions for a quarter-turn display matrix", () => {
    assert.deepEqual(Mp4Dimensions.read(movie(640, 360, { quarterTurn: true })), { width: 360, height: 640 });
  });

  it("accepts extended-size and zero-size boxes", () => {
    assert.deepEqual(Mp4Dimensions.read(movie(800, 450, { moovMode: "extended" })), { width: 800, height: 450 });
    assert.deepEqual(Mp4Dimensions.read(movie(800, 450, { moovMode: "zero" })), { width: 800, height: 450 });
    assert.deepEqual(Mp4Dimensions.read(movie(800, 450, { tkhdMode: "extended" })), { width: 800, height: 450 });
  });

  it("keeps integer pixel values from fixed-point track fields", () => {
    const bytes = movie(640, 360);
    const tag = bytes.findIndex((_value, index) => index + 4 <= bytes.length
      && bytes[index] === 0x74 && bytes[index + 1] === 0x6b && bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64);
    const widthOffset = tag + 4 + 40 + 36;
    writeU32(bytes, widthOffset, 640 * 65_536 + 0x8000);
    assert.deepEqual(Mp4Dimensions.read(bytes), { width: 640, height: 360 });
  });

  it("continues past a malformed movie box and uses a later valid movie box", () => {
    assert.deepEqual(Mp4Dimensions.read(concat(malformedMoov(), movie(320, 180))), { width: 320, height: 180 });
  });

  it("checks each track and each header until it finds usable dimensions", () => {
    const invalidHeader = box("tkhd", new Uint8Array([0, 1, 2]));
    const firstTrack = box("trak", invalidHeader);
    const secondTrack = box("trak", box("tkhd", trackHeader(480, 270)));
    assert.deepEqual(Mp4Dimensions.read(concat(box("ftyp", new Uint8Array()), box("moov", concat(firstTrack, secondTrack)))), {
      width: 480,
      height: 270,
    });
  });

  it("returns no dimensions for missing or truncated movie structure", () => {
    assert.equal(Mp4Dimensions.read(new Uint8Array()), null);
    assert.equal(Mp4Dimensions.read(box("ftyp", new Uint8Array())), null);
    assert.equal(Mp4Dimensions.read(malformedMoov()), null);
    const extendedHeaderOnly = new Uint8Array(12);
    writeU32(extendedHeaderOnly, 0, 1);
    for (let index = 0; index < 4; index += 1) extendedHeaderOnly[4 + index] = "moov".charCodeAt(index);
    assert.equal(Mp4Dimensions.read(extendedHeaderOnly), null);
  });

  it("rejects zero width or height rather than returning an invalid size", () => {
    assert.equal(Mp4Dimensions.read(movie(0, 360)), null);
    assert.equal(Mp4Dimensions.read(movie(640, 0)), null);
  });

  it("rejects a track header whose matrix and dimensions are truncated", () => {
    const shortTrack = box("trak", box("tkhd", new Uint8Array(20)));
    assert.equal(Mp4Dimensions.read(box("moov", shortTrack)), null);
  });
});
