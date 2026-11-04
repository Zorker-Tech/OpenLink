import type { MediaDimensions } from "./image-dimensions.ts";
import type { MediaBoxRange } from "./video-dimensions-boxes.ts";
import { readUnsignedBigEndian32 } from "./video-dimensions-boxes.ts";

function validDimensions(width: number, height: number): MediaDimensions | null {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/** Read the display size carried by one track-header content span. */
export function dimensionsFromTrackHeader(bytes: Uint8Array, header: MediaBoxRange): MediaDimensions | null {
  if (header.start >= header.end) return null;

  const version = bytes[header.start]!;
  const timestampFieldBytes = version === 1 ? 12 : 0;
  const matrix = header.start + 40 + timestampFieldBytes;
  const dimensions = matrix + 36;
  if (dimensions + 8 > header.end) return null;

  const width = readIntegerPart(bytes, dimensions);
  const height = readIntegerPart(bytes, dimensions + 4);
  return quarterTurnMatrix(bytes, matrix)
    ? validDimensions(height, width)
    : validDimensions(width, height);
}

function readIntegerPart(bytes: Uint8Array, offset: number): number {
  return readUnsignedBigEndian32(bytes, offset) >>> 16;
}

function quarterTurnMatrix(bytes: Uint8Array, matrix: number): boolean {
  const firstAxisX = readUnsignedBigEndian32(bytes, matrix);
  const firstAxisY = readUnsignedBigEndian32(bytes, matrix + 4);
  const secondAxisX = readUnsignedBigEndian32(bytes, matrix + 12);
  const secondAxisY = readUnsignedBigEndian32(bytes, matrix + 16);
  return firstAxisX === 0 && secondAxisY === 0 && firstAxisY !== 0 && secondAxisX !== 0;
}
