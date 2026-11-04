export interface MediaBoxRange {
  readonly start: number;
  readonly end: number;
}

export interface ParsedBox {
  readonly content: MediaBoxRange;
  readonly nextOffset: number;
}

/** Find a four-byte box name, beginning after the first box-size word. */
export function findNextBoxType(bytes: Uint8Array, type: string, fromOffset: number): number {
  const wanted = [...type].map((character) => character.charCodeAt(0));
  for (let offset = Math.max(fromOffset, 4); offset + 4 <= bytes.length; offset += 1) {
    if (bytes[offset] === wanted[0]
      && bytes[offset + 1] === wanted[1]
      && bytes[offset + 2] === wanted[2]
      && bytes[offset + 3] === wanted[3]) return offset;
  }
  return -1;
}

/** Read a box's content bounds from its standard, extended or to-container-end size form. */
export function readMediaBox(bytes: Uint8Array, start: number, containerEnd: number): ParsedBox | null {
  if (start < 0 || start + 8 > containerEnd) return null;

  let totalSize = readUnsignedBigEndian32(bytes, start);
  let headerSize = 8;
  if (totalSize === 1) {
    if (start + 16 > containerEnd) return null;
    totalSize = readUnsignedBigEndian32(bytes, start + 12);
    headerSize = 16;
  } else if (totalSize === 0) {
    totalSize = containerEnd - start;
  }

  if (totalSize < headerSize) return null;
  return {
    content: { start: start + headerSize, end: Math.min(start + totalSize, containerEnd) },
    nextOffset: start + totalSize,
  };
}

/** Return the content spans of children with the requested four-byte type. */
export function findChildBoxContents(bytes: Uint8Array, parent: MediaBoxRange, type: string): MediaBoxRange[] {
  const matches: MediaBoxRange[] = [];
  let offset = parent.start;
  while (offset + 8 <= parent.end) {
    const box = readMediaBox(bytes, offset, parent.end);
    if (box == null) break;
    if (readBoxType(bytes, offset + 4) === type) matches.push(box.content);
    if (box.nextOffset > parent.end) break;
    offset = box.nextOffset;
  }
  return matches;
}

export function readUnsignedBigEndian32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!) >>> 0;
}

function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}
