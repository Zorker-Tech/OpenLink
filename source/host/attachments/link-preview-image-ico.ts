import { pngSize } from "../../shared/media/image-dimensions.ts"
import type { ImageSize } from "./link-preview-image-contracts.ts"

const acceptedDibHeaders = new Set([40, 52, 56, 108, 124])

function sizeFromBitmapHeader(bytes: Buffer, start: number): ImageSize | null {
  if (start + 12 > bytes.length || !acceptedDibHeaders.has(bytes.readUInt32LE(start))) return null
  const width = bytes.readInt32LE(start + 4)
  const height = Math.ceil(Math.abs(bytes.readInt32LE(start + 8)) / 2)
  return width > 0 && height > 0 ? { width, height } : null
}

function directoryDimension(value: number): number {
  return value === 0 ? 256 : value
}

function larger(current: ImageSize | null, candidate: ImageSize | null): ImageSize | null {
  if (candidate === null) return current
  if (current === null || candidate.width * candidate.height > current.width * current.height) return candidate
  return current
}

/** Read the largest useful declared or embedded image from an icon directory. */
export function readIcoSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0) return null

  const type = bytes.readUInt16LE(2)
  const entryCount = bytes.readUInt16LE(4)
  if ((type !== 1 && type !== 2) || entryCount === 0 || bytes.length < 6 + entryCount * 16) return null

  let largest: ImageSize | null = null
  for (let index = 0; index < entryCount; index += 1) {
    const entryStart = 6 + index * 16
    largest = larger(largest, {
      width: directoryDimension(bytes[entryStart]!),
      height: directoryDimension(bytes[entryStart + 1]!),
    })

    const imageStart = bytes.readUInt32LE(entryStart + 12)
    if (imageStart >= bytes.length) continue
    const imageBytes = bytes.subarray(imageStart)
    largest = larger(largest, pngSize(imageBytes))
    largest = larger(largest, sizeFromBitmapHeader(bytes, imageStart))
  }
  return largest
}
