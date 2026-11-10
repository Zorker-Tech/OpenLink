import type { WebpDimensions } from "./webp-contracts.ts"

type DimensionReader = (buffer: Buffer) => WebpDimensions | undefined

function asciiAt(buffer: Buffer, start: number, end: number, expected: string): boolean {
  return buffer.toString("ascii", start, end) === expected
}

export function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12 &&
    asciiAt(buffer, 0, 4, "RIFF") &&
    asciiAt(buffer, 8, 12, "WEBP")
}

function lossyDimensions(buffer: Buffer): WebpDimensions | undefined {
  if (
    buffer.length < 30 ||
    buffer[23] !== 157 ||
    buffer[24] !== 1 ||
    buffer[25] !== 42
  ) return undefined
  return {
    width: buffer.readUInt16LE(26) & 16383,
    height: buffer.readUInt16LE(28) & 16383,
  }
}

function losslessDimensions(buffer: Buffer): WebpDimensions | undefined {
  if (buffer.length < 25 || buffer[20] !== 47) return undefined
  const flags = buffer.readUInt32LE(21)
  return {
    width: (flags & 16383) + 1,
    height: (flags >>> 14 & 16383) + 1,
  }
}

function extendedDimensions(buffer: Buffer): WebpDimensions | undefined {
  if (buffer.length < 30) return undefined
  return {
    width: buffer.readUIntLE(24, 3) + 1,
    height: buffer.readUIntLE(27, 3) + 1,
  }
}

const dimensionsForChunk = new Map<string, DimensionReader>([
  ["VP8 ", lossyDimensions],
  ["VP8L", losslessDimensions],
  ["VP8X", extendedDimensions],
])

export function webpSize(buffer: Buffer): WebpDimensions | undefined {
  if (!isWebp(buffer) || buffer.length < 16) return undefined
  return dimensionsForChunk.get(buffer.toString("ascii", 12, 16))?.(buffer)
}
