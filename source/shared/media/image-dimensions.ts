/**
 * How large an image is, read from the file itself.
 *
 * The size of an image is in its header, and each format writes it differently: little-endian in WebP and GIF, big-endian in
 * PNG and the ISO boxes a HEIC is made of, and in a JPEG only after walking past segments that may be arbitrarily long.
 * This file reads those headers, and nothing else:
 *
 * - **a header that cannot be read is not a guess** — a short buffer, a wrong signature, a length that runs past the end, a
 *   zero width or height: each is no answer, rather than an approximate one;
 * - **a HEIC's size is its primary item's**, with the image's own rotation applied — the boxes are walked to the item the
 *   file says is primary, and only a file whose primary item cannot be found falls back to the first `ispe` box;
 * - **a JPEG's size is the first frame header** — the segments before it are skipped by their declared lengths, and a file
 *   whose scan starts before any frame header has no size here.
 */
export interface MediaDimensions {
  readonly width: number;
  readonly height: number;
}

/** A size, or nothing when it is not a size: zero and non-finite values are not dimensions. */
function sizeOf(width: number, height: number): MediaDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

const u16be = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const u32be = (bytes: Uint8Array, at: number): number => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const u16le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u24le = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const u32le = (bytes: Uint8Array, at: number): number => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
const tagAt = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

/** Where a four-character tag appears, or -1: used only by the HEIC fallback, which has no box walk to rely on. */
function findTag(bytes: Uint8Array, tag: string): number {
  const wanted = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
  for (let at = 0; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] === wanted[0] && bytes[at + 1] === wanted[1] && bytes[at + 2] === wanted[2] && bytes[at + 3] === wanted[3]) return at;
  }
  return -1;
}

/* ---------------------------------------------------------------- HEIC (ISO boxes) */

interface IsoBox {
  readonly type: string;
  readonly body: number;
  readonly end: number;
}

/** The boxes inside a range, in order: a size of 1 means a 64-bit size follows, and a size of 0 runs to the end. */
function boxesIn(bytes: Uint8Array, range: { readonly start: number; readonly end: number }): IsoBox[] {
  const boxes: IsoBox[] = [];
  let at = range.start;
  while (at + 8 <= range.end) {
    let size = u32be(bytes, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > range.end) break;
      size = u32be(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      size = range.end - at;
    }
    // A box that claims to be smaller than its own header, or to run past its parent, ends the walk: the rest cannot be trusted.
    if (size < header || at + size > range.end) break;
    boxes.push({ type: tagAt(bytes, at + 4), body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

/** The body of a box, optionally skipping a fixed number of bytes (a version and flags, usually). */
function bodyOf(box: IsoBox, skip = 0): { readonly start: number; readonly end: number } {
  return { start: box.body + skip, end: box.end };
}

/** The id of the item the file says is its primary one. */
function primaryItemId(bytes: Uint8Array, pitm: IsoBox): number | null {
  if (pitm.body + 6 > pitm.end) return null;
  if (bytes[pitm.body]! === 0) return u16be(bytes, pitm.body + 4);
  const at = pitm.body + 4;
  return at + 4 > pitm.end ? null : u32be(bytes, at);
}

/** The property indices an item is associated with, in the order the file lists them. */
function propertyIndicesFor(bytes: Uint8Array, ipma: IsoBox, itemId: number): number[] | null {
  let at = ipma.body;
  if (at + 8 > ipma.end) return null;
  const version = bytes[at]!;
  const flags = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
  at += 4;
  const entryCount = u32be(bytes, at);
  at += 4;
  const idBytes = version >= 1 ? 4 : 2;
  const wideIndices = (flags & 1) === 1;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (at + idBytes + 1 > ipma.end) return null;
    const id = idBytes === 4 ? u32be(bytes, at) : u16be(bytes, at);
    at += idBytes;
    const associations = bytes[at]!;
    at += 1;
    const indices: number[] = [];
    for (let association = 0; association < associations; association += 1) {
      if (wideIndices) {
        if (at + 2 > ipma.end) return null;
        indices.push(u16be(bytes, at) & 32_767);
        at += 2;
      } else {
        if (at + 1 > ipma.end) return null;
        indices.push(bytes[at]! & 127);
        at += 1;
      }
    }
    if (id === itemId) return indices;
  }
  return null;
}

/**
 * Where the primary image's `ispe` box is, and how many quarter turns the file says it has. The walk is
 * `meta → (pitm, iprp → (ipco, ipma))`; anything missing on the way falls back to the first `ispe` in the file.
 */
function primaryImageIn(bytes: Uint8Array): { readonly ispeBody: number; readonly quarterTurns: number } | null {
  const firstIspe = findTag(bytes, "ispe");
  const firstIrot = findTag(bytes, "irot");
  const fallback = (): { readonly ispeBody: number; readonly quarterTurns: number } | null => {
    if (firstIspe < 0 || firstIspe + 16 > bytes.length) return null;
    return { ispeBody: firstIspe + 8, quarterTurns: firstIrot >= 0 && firstIrot + 4 < bytes.length ? bytes[firstIrot + 4]! & 3 : 0 };
  };
  const meta = boxesIn(bytes, { start: 0, end: bytes.length }).find((box) => box.type === "meta");
  if (meta == null) return fallback();
  const metaBoxes = boxesIn(bytes, bodyOf(meta, 4));
  const pitm = metaBoxes.find((box) => box.type === "pitm");
  const iprp = metaBoxes.find((box) => box.type === "iprp");
  if (pitm == null || iprp == null) return fallback();
  const iprpBoxes = boxesIn(bytes, bodyOf(iprp));
  const ipco = iprpBoxes.find((box) => box.type === "ipco");
  const ipma = iprpBoxes.find((box) => box.type === "ipma");
  if (ipco == null || ipma == null) return fallback();
  const properties = boxesIn(bytes, bodyOf(ipco));
  const primaryId = primaryItemId(bytes, pitm);
  const indices = primaryId == null ? null : propertyIndicesFor(bytes, ipma, primaryId);
  if (indices == null) return fallback();
  let ispeBody: number | null = null;
  let quarterTurns = 0;
  for (const index of indices) {
    const property = properties[index - 1];
    if (property == null) continue;
    if (property.type === "ispe" && ispeBody == null && property.body + 12 <= property.end) ispeBody = property.body + 4;
    else if (property.type === "irot" && property.body < property.end) quarterTurns = bytes[property.body]! & 3;
  }
  return ispeBody == null ? fallback() : { ispeBody, quarterTurns };
}

/** A HEIC's size, turned the way the file says the image is turned. */
export function heicSize(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 12 || tagAt(bytes, 4) !== "ftyp") return null;
  const primary = primaryImageIn(bytes);
  if (primary == null) return null;
  const width = u32be(bytes, primary.ispeBody);
  const height = u32be(bytes, primary.ispeBody + 4);
  // A quarter turn swaps the axes: the size the file records is the unturned image.
  return primary.quarterTurns === 1 || primary.quarterTurns === 3 ? sizeOf(height, width) : sizeOf(width, height);
}

/* ---------------------------------------------------------------- WebP */

export function webpSize(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 30 || tagAt(bytes, 0) !== "RIFF" || tagAt(bytes, 8) !== "WEBP") return null;
  switch (tagAt(bytes, 12)) {
    // A lossy frame: two 14-bit fields, with the scale bits masked off.
    case "VP8 ":
      return sizeOf(u16le(bytes, 26) & 16_383, u16le(bytes, 28) & 16_383);
    // A lossless frame: both dimensions are packed into one 32-bit field, minus one.
    case "VP8L": {
      const packed = u32le(bytes, 21);
      return sizeOf((packed & 16_383) + 1, ((packed >>> 14) & 16_383) + 1);
    }
    // An extended file: the canvas size is two 24-bit fields, minus one.
    case "VP8X":
      return sizeOf(u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
    default:
      return null;
  }
}

export function webpOrHeicSize(bytes: Uint8Array): MediaDimensions | null {
  return webpSize(bytes) ?? heicSize(bytes);
}

/* ---------------------------------------------------------------- PNG, GIF, JPEG */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** JPEG markers that carry no length: stand-alone markers and the table-of-contents restart codes. */
const JPEG_SEGMENTLESS_MARKERS = new Set([1, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217]);
/** Markers in the frame-header range that are not frame headers (Huffman tables, arithmetic coding). */
const JPEG_NON_FRAME_MARKERS = new Set([196, 200, 204]);

export function pngSize(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  // The first chunk of a PNG must be the image header, which is where its size is.
  if (tagAt(bytes, 12) !== "IHDR") return null;
  return sizeOf(u32be(bytes, 16), u32be(bytes, 20));
}

export function gifSize(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 10) return null;
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  // The logical screen descriptor follows the header, little-endian.
  return sizeOf(u16le(bytes, 6), u16le(bytes, 8));
}

/**
 * A JPEG's size is in its first frame header. Segments are skipped by their own declared lengths, and the walk stops at the
 * scan (there is nothing to read after it here) or at the end of the buffer.
 */
export function jpegSize(bytes: Uint8Array): MediaDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 255) {
      // Not at a marker: a byte of padding between segments is skipped a byte at a time.
      at += 1;
      continue;
    }
    const marker = bytes[at + 1]!;
    if (marker === 255) {
      // A fill byte: the real marker is the next one.
      at += 1;
      continue;
    }
    if (JPEG_SEGMENTLESS_MARKERS.has(marker)) {
      at += 2;
      continue;
    }
    if (marker === 218) return null;
    const segmentLength = u16be(bytes, at + 2);
    if (segmentLength < 2) return null;
    const isFrameHeader = marker >= 192 && marker <= 207 && !JPEG_NON_FRAME_MARKERS.has(marker);
    if (isFrameHeader) {
      if (at + 9 > bytes.length) return null;
      // The frame header carries height first, then width.
      return sizeOf(u16be(bytes, at + 7), u16be(bytes, at + 5));
    }
    at += 2 + segmentLength;
  }
  return null;
}

/** Any of the formats this file knows, by its own signature. */
export function imageFileSize(bytes: Uint8Array): MediaDimensions | null {
  return webpOrHeicSize(bytes) ?? pngSize(bytes) ?? gifSize(bytes) ?? jpegSize(bytes);
}
