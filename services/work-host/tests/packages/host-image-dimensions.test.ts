/**
 * Reading an image's size out of its own header: each format's own layout, and the cases where a header cannot be read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  gifSize,
  heicSize,
  imageFileSize,
  jpegSize,
  pngSize,
  webpOrHeicSize,
  webpSize,
} from "../../source/shared/media/image-dimensions.ts";

type ByteParts = number | readonly number[] | Uint8Array | string;
const bytes = (...parts: ByteParts[]): Uint8Array => {
  const flat = parts.flatMap((part) =>
    typeof part === "string" ? [...Buffer.from(part, "latin1")] : typeof part === "number" ? [part] : [...Array.from(part)],
  );
  return Uint8Array.from(flat);
};
const u32be = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const u16be = (value: number) => [(value >>> 8) & 255, value & 255];
const u16le = (value: number) => [value & 255, (value >>> 8) & 255];
const u24le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
const u32le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
/** An ISO box: its 32-bit size, its four-character type, then its body. */
const box = (type: string, body: readonly number[] | Uint8Array): number[] => [...u32be(8 + body.length), ...bytes(type), ...Array.from(body)];

const png = (width: number, height: number) => bytes([137, 80, 78, 71, 13, 10, 26, 10], u32be(13), "IHDR", u32be(width), u32be(height), [8, 2, 0, 0, 0]);
const gif = (version: string, width: number, height: number) => bytes(version, u16le(width), u16le(height), [0, 0, 0]);
const jpeg = (segments: ReadonlyArray<readonly number[] | Uint8Array>) => bytes([255, 216], ...segments);
const jpegSegment = (marker: number, body: readonly number[] | Uint8Array) => bytes([255, marker], u16be(body.length + 2), body);
const sof0 = (width: number, height: number) => jpegSegment(192, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const webpFile = (chunk: string, body: readonly number[] | Uint8Array) => {
  const riffBody = [...bytes("WEBP"), ...bytes(chunk), ...u32le(body.length), ...Array.from(body)];
  return { bytes: bytes("RIFF", u32le(riffBody.length), riffBody), body };
};
const pad = (length: number) => Array.from({ length }, () => 0);

/** A minimal HEIC: a file type box, then a meta box with the primary item, its properties and their associations. */
function heicDimensionsFile(options: { width: number; height: number; quarterTurns: number; withMeta?: boolean; itemId?: number; associated?: number } = { width: 400, height: 300, quarterTurns: 0 }) {
    const ispe = box("ispe", [...u32be(0), ...u32be(options.width), ...u32be(options.height)]);
    const irot = box("irot", [options.quarterTurns]);
    const ipco = box("ipco", [...ispe, ...irot]);
    const itemId = options.itemId ?? 1;
    const ipma = box("ipma", [...u32be(0), ...u32be(1), ...u16be(itemId), options.associated ?? 2, 1, 2]);
    const iprp = box("iprp", [...ipco, ...ipma]);
    const pitm = box("pitm", [...u32be(0), ...u16be(itemId)]);
    const meta = box("meta", [...u32be(0), ...pitm, ...iprp]);
    const ftyp = box("ftyp", [...bytes("heic"), ...pad(4)]);
    return options.withMeta === false ? bytes(ftyp, ispe) : bytes(ftyp, meta);
}

describe("PNG", () => {
  it("reads the image header's size and refuses anything that is not one", () => {
    assert.deepEqual(pngSize(png(640, 480)), { width: 640, height: 480 });
    assert.equal(pngSize(bytes([137, 80, 78, 71])), null, "a truncated file has no size");
    assert.equal(pngSize(bytes([0, 1, 2, 3, 4, 5, 6, 7], u32be(13), "IHDR", u32be(1), u32be(1))), null, "the signature is the only signature");
    // A file whose first chunk is not the image header is not a PNG this reader understands.
    assert.equal(pngSize(bytes([137, 80, 78, 71, 13, 10, 26, 10], u32be(13), "IDAT", u32be(1), u32be(1))), null);
    assert.equal(pngSize(png(0, 10)), null);
  });
});

describe("GIF", () => {
  it("reads the screen descriptor of both versions, and nothing else", () => {
    assert.deepEqual(gifSize(gif("GIF87a", 16, 9)), { width: 16, height: 9 });
    assert.deepEqual(gifSize(gif("GIF89a", 300, 200)), { width: 300, height: 200 });
    assert.equal(gifSize(gif("GIF90a", 1, 1)), null);
    assert.equal(gifSize(bytes("GIF89a", [1])), null);
    assert.equal(gifSize(gif("GIF89a", 0, 0)), null);
  });
});

describe("JPEG", () => {
  it("walks to the first frame header, skipping the segments and padding before it", () => {
    assert.deepEqual(jpegSize(jpeg([jpegSegment(224, pad(20)), sof0(1024, 768)])), { width: 1024, height: 768 });
    // A byte that is not a marker prefix is skipped one at a time until the next segment.
    assert.deepEqual(jpegSize(jpeg([pad(2), jpegSegment(225, pad(4)), sof0(10, 20)])), { width: 10, height: 20 });
    // A fill byte before the real marker is skipped as well.
    assert.deepEqual(jpegSize(jpeg([[255], jpegSegment(225, pad(2)), sof0(11, 21)])), { width: 11, height: 21 });
    // A Huffman table (196) sits in the frame-header range but is not a frame header.
    assert.deepEqual(jpegSize(jpeg([jpegSegment(196, pad(4)), jpegSegment(224, pad(2)), sof0(7, 9)])), { width: 7, height: 9 });
  });

  it("has no size when the scan starts first, or when the header cannot be trusted", () => {
    assert.equal(jpegSize(jpeg([jpegSegment(218, pad(1))])), null, "the scan begins before any frame header");
    assert.equal(jpegSize(jpeg([[255, 225, 0, 1]])), null, "a segment shorter than its own length is refused");
    assert.equal(jpegSize(bytes([255, 216, 255])), null);
    assert.equal(jpegSize(bytes([0, 0, 0, 0])), null);
    // A frame header whose size fields are cut off has nothing to read.
    assert.equal(jpegSize(jpeg([[255, 192, 0, 4, 8]])), null);
    assert.equal(jpegSize(jpeg([sof0(0, 10)])), null);
  });
});

describe("WebP", () => {
  it("reads a lossy, a lossless and an extended file", () => {
    // A lossy frame: three bytes of frame tag and three of start code, then the two sizes.
    const lossyBody = [...pad(6), ...u16le(0x1234), ...u16le(0x5678), ...pad(2)];
    const lossy = webpFile("VP8 ", lossyBody);
    // The two sizes are 14-bit fields: the scale bits above them are not part of the size.
    assert.deepEqual(webpSize(lossy.bytes), { width: 0x1234, height: 0x5678 & 16_383 });
    // The lossless format packs both sizes into one 32-bit field, each 14 bits and minus one.
    // Each field is the size minus one, so the file stores 299 and 199 for a 300x200 image.
    const packed = 299 | (199 << 14);
    const losslessBody = [...pad(1), ...u32le(packed), ...pad(8)];
    assert.deepEqual(webpSize(webpFile("VP8L", losslessBody).bytes), { width: 300, height: 200 });
    // The extended format writes two 24-bit fields, minus one each.
    const extendedBody = [...pad(4), ...u24le(639), ...u24le(479), ...pad(5)];
    assert.deepEqual(webpSize(webpFile("VP8X", extendedBody).bytes), { width: 640, height: 480 });
  });

  it("refuses a file that is short, mislabelled, or of an unknown chunk", () => {
    assert.equal(webpSize(Uint8Array.from(pad(40))), null);
    const wrong = webpFile("VP8 ", [...pad(4), ...u16le(4), ...u16le(4), ...pad(4)]);
    // A container that says RIFF but not WEBP is not a WebP, however plausible its chunk tag looks. Every byte after
    // the header is non-zero, so a reader that skipped the check would find numbers where the sizes would be.
    const wave = bytes("RIFF", u32le(60), "WAVE", "VP8 ", u32le(40), Array.from({ length: 40 }, () => 0x11));
    assert.equal(webpSize(wave), null);
    const unknown = webpFile("ALPH", pad(24));
    assert.equal(webpSize(unknown.bytes), null);
    // A frame whose size field is zero is not a size.
    const zero = webpFile("VP8 ", [...pad(6), ...u16le(0), ...u16le(5), ...pad(2)]);
    assert.equal(webpSize(zero.bytes), null);
  });
});

describe("HEIC", () => {
  it("reads the primary item's size, and turns it the way the file says", () => {
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 400, height: 300, quarterTurns: 0 })), { width: 400, height: 300 });
    // A quarter turn or three swaps the axes; two half turns do not.
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 400, height: 300, quarterTurns: 1 })), { width: 300, height: 400 });
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 400, height: 300, quarterTurns: 3 })), { width: 300, height: 400 });
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 400, height: 300, quarterTurns: 2 })), { width: 400, height: 300 });
    // A primary item that is not in the property list falls back to the first image-size box in the file.
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 40, height: 30, quarterTurns: 0, itemId: 2, associated: 0 })), { width: 40, height: 30 });
    // Without a meta box there is nothing to walk, so the first image-size box is used.
    assert.deepEqual(heicSize(heicDimensionsFile({ width: 64, height: 32, quarterTurns: 0, withMeta: false })), { width: 64, height: 32 });
  });

  it("refuses a file that is not a HEIC or has no image-size box", () => {
    assert.equal(heicSize(Uint8Array.from(pad(32))), null);
    assert.equal(heicSize(bytes("RIFF", u32le(20), "WEBP", pad(20))), null);
    const noIspe = bytes(box("ftyp", [...bytes("heic"), ...pad(4)]), box("meta", [...u32be(0), ...box("pitm", [...u32be(0), ...u16be(1)])]));
    assert.equal(heicSize(noIspe), null);
    // A zero width is not a size, even in a well-formed file.
    assert.equal(heicSize(heicDimensionsFile({ width: 0, height: 300, quarterTurns: 0 })), null);
  });

  it("is what a WebP-or-HEIC reader falls back to", () => {
    assert.deepEqual(webpOrHeicSize(heicDimensionsFile({ width: 10, height: 20, quarterTurns: 0 })), { width: 10, height: 20 });
    const lossy = webpFile("VP8 ", [...pad(6), ...u16le(4), ...u16le(6), ...pad(2)]);
    assert.deepEqual(webpOrHeicSize(lossy.bytes), { width: 4, height: 6 });
    assert.equal(webpOrHeicSize(Uint8Array.from(pad(40))), null);
  });
});

describe("any image file", () => {
  it("picks the reader by the file's own signature", () => {
    assert.deepEqual(imageFileSize(png(2, 3)), { width: 2, height: 3 });
    assert.deepEqual(imageFileSize(gif("GIF89a", 4, 5)), { width: 4, height: 5 });
    assert.deepEqual(imageFileSize(jpeg([sof0(6, 7)])), { width: 6, height: 7 });
    const lossy = webpFile("VP8 ", [...pad(6), ...u16le(8), ...u16le(9), ...pad(2)]);
    assert.deepEqual(imageFileSize(lossy.bytes), { width: 8, height: 9 });
    assert.deepEqual(imageFileSize(heicDimensionsFile({ width: 10, height: 11, quarterTurns: 0 })), { width: 10, height: 11 });
    assert.equal(imageFileSize(bytes("not an image at all")), null);
    assert.equal(imageFileSize(Uint8Array.from(pad(0))), null);
  });
});
