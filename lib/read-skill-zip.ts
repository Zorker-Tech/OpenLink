const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
const MAX_SKILL_BYTES = 200_000

function findEndOfCentralDirectory(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return -1
}

async function inflateRaw(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') throw new Error('ZIP_DECOMPRESSION_UNSUPPORTED')
  const input = new Blob([bytes.slice().buffer])
  const stream = input.stream().pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Reads the first SKILL.md from a small ZIP without unpacking unrelated files. */
export async function readSkillZip(file: File) {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP_TOO_LARGE')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  if (eocd < 0) throw new Error('INVALID_ZIP')

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error('INVALID_ZIP')
    const compression = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const fileNameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const nameStart = offset + 46
    const entryName = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength))

    if (/(^|\/)SKILL\.md$/i.test(entryName)) {
      if (uncompressedSize > MAX_SKILL_BYTES) throw new Error('SKILL_TOO_LARGE')
      if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error('INVALID_ZIP')
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      if (dataStart + compressedSize > view.byteLength) throw new Error('INVALID_ZIP')
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
      const contentBytes = compression === 0
        ? compressed
        : compression === 8
          ? await inflateRaw(compressed)
          : (() => { throw new Error('ZIP_COMPRESSION_UNSUPPORTED') })()
      if (contentBytes.byteLength > MAX_SKILL_BYTES) throw new Error('SKILL_TOO_LARGE')
      const segments = entryName.split('/').filter(Boolean)
      const archiveName = file.name.replace(/\.zip$/i, '')
      return {
        name: segments.length > 1 ? segments.at(-2) || archiveName : archiveName,
        content: decoder.decode(contentBytes),
      }
    }

    offset += 46 + fileNameLength + extraLength + commentLength
  }

  throw new Error('SKILL_MD_NOT_FOUND')
}
