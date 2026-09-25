/**
 * Reading files as text: what a file is, and how to decode it.
 *
 * A file's encoding is rarely declared, so it is inferred from its first bytes — byte-order marks
 * first, then a UTF-8 validity check, then a statistical detector — and remembered per path so a
 * second read of the same file cannot disagree with the first. Line endings are normalized on read:
 * everything above this layer works with `\n`.
 */

import { isUtf8 } from "node:buffer"
import { open, readFile } from "node:fs/promises"
import { TextDecoder } from "node:util"

import * as iconv from "iconv-lite"
import * as jschardet from "jschardet"

import {
  LATIN1_ENCODING,
  UTF8_BOM_ENCODING,
  UTF8_ENCODING,
  mapToIconvEncoding,
  normalizeEncodingName,
  stripUtf8Bom,
} from "./encoding-names.ts"

export const LineEnding = {
  CRLF: "CRLF",
  LF: "LF",
} as const

export type LineEnding = (typeof LineEnding)[keyof typeof LineEnding]

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".m4v"])
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })
const LATIN1_DECODER = new TextDecoder("latin1")
const UTF8_BOM_BYTES = Buffer.from([239, 187, 191])
const ESCAPE_BYTE = 27
const DETECTED_UTF8_ENCODING = "UTF-8"
const DETECTOR_CONFIDENCE = 0.7
const MAX_REMEMBERED_ENCODINGS = 100
const HEADER_BYTES = 8192
const BINARY_SAMPLE_BYTES = 4096
const MAX_NON_PRINTABLE_PERCENT = 5
const CRLF_SHARE_PERCENT = 5

/** Path → the encoding its last read settled on. Bounded, oldest first. */
const fileEncodings = new Map<string, string>()

export interface FileFormat {
  readonly encoding: string
  readonly lineEnding: LineEnding
  readonly isBinaryFile: boolean
  readonly isImageFile: boolean
  readonly isVideoFile: boolean
}

function getFileExtension(filePath: string): string {
  const lowerCasePath = filePath.toLowerCase()
  const lastDotIndex = lowerCasePath.lastIndexOf(".")
  return lastDotIndex === -1 ? "" : lowerCasePath.substring(lastDotIndex)
}

export function isVideoFilePath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(getFileExtension(filePath))
}

export async function readText(filePath: string, encodingHint?: string): Promise<string> {
  const buffer = await readFile(filePath)
  const format = formatOf(buffer)
  if (format.isBinaryFile) throw new Error("Binary file cannot be decoded as text")
  const encoding = encodingHint ?? fileEncodings.get(filePath) ?? format.encoding
  const decoded = decode(buffer, encoding)
  const text = stripUtf8Bom(decoded.text)
  rememberEncoding(filePath, decoded.encoding === UTF8_ENCODING && hasUtf8Bom(buffer) ? UTF8_BOM_ENCODING : decoded.encoding)
  return format.lineEnding === LineEnding.CRLF ? text.replaceAll("\r\n", "\n") : text
}

export async function getFormatForFile(filePath: string): Promise<FileFormat> {
  const format = formatOf(await readFirstBytes(filePath))
  if (!format.isBinaryFile) return { ...format, isVideoFile: false }
  return { ...format, isVideoFile: isVideoFilePath(filePath) }
}

export function countLines(data: string): number {
  if (data === "") return 1
  let lines = 1
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\n") lines += 1
  }
  return lines
}

function formatOf(header: Buffer): FileFormat {
  if (header.length === 0) return defaultTextFormat()
  const utf16 = detectUtf16(header)
  if (utf16 !== null) return textFormat(utf16, header)
  const utf32 = detectUtf32(header)
  if (utf32 !== null) return textFormat(utf32, header)
  if (!looksLikeText(header)) {
    return {
      encoding: "binary",
      lineEnding: LineEnding.LF,
      isBinaryFile: true,
      isImageFile: looksLikeImage(header),
      isVideoFile: false,
    }
  }
  if (isUtf8(header) && !header.includes(ESCAPE_BYTE)) return textFormat(DETECTED_UTF8_ENCODING, header)
  const detected = jschardet.detect(header)
  const encoding = detected.confidence > DETECTOR_CONFIDENCE ? detected.encoding : "utf-8"
  return textFormat(encoding === "ascii" ? "utf-8" : encoding ?? "utf-8", header)
}

function textFormat(encoding: string, header: Buffer): FileFormat {
  return {
    encoding,
    lineEnding: detectLineEnding(header),
    isBinaryFile: false,
    isImageFile: false,
    isVideoFile: false,
  }
}

function defaultTextFormat(): FileFormat {
  return {
    encoding: UTF8_ENCODING,
    lineEnding: process.platform === "win32" ? LineEnding.CRLF : LineEnding.LF,
    isBinaryFile: false,
    isImageFile: false,
    isVideoFile: false,
  }
}

/**
 * A file counts as text when it holds no null byte and few control characters: the same test an
 * editor uses, and deliberately lenient — a false "text" is recoverable, a false "binary" is not.
 */
function looksLikeText(buffer: Buffer): boolean {
  const length = Math.min(BINARY_SAMPLE_BYTES, buffer.length)
  if (length === 0) return true
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) return false
  }
  let nonPrintable = 0
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[index] ?? 0
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) nonPrintable += 1
  }
  return nonPrintable / length * 100 < MAX_NON_PRINTABLE_PERCENT
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return true
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return true
  return buffer.length >= 6 && buffer.subarray(0, 4).toString("ascii") === "GIF8" &&
    (buffer[4] === 55 || buffer[4] === 57) && buffer[5] === 97
}

function detectLineEnding(buffer: Buffer): LineEnding {
  let crlf = 0
  let lfOnly = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 10) continue
    if (index > 0 && buffer[index - 1] === 13) crlf += 1
    else lfOnly += 1
  }
  if (crlf === 0 && lfOnly === 0) return LineEnding.LF
  return crlf / (crlf + lfOnly) * 100 >= CRLF_SHARE_PERCENT ? LineEnding.CRLF : LineEnding.LF
}

function isPrintable(char: number): boolean {
  return (char >= 32 && char <= 126) || char === 9 || char === 10 || char === 13
}

/** A byte-order mark is conclusive; without one, a wide-encoded file shows up as printable bytes
 *  separated by nulls, which is what the sampling below looks for. */
function detectUtf16(buffer: Buffer): string | null {
  if (buffer.length < 4) return null
  if (buffer[0] === 255 && buffer[1] === 254 && !(buffer[2] === 0 && buffer[3] === 0)) return "UTF-16LE"
  if (buffer[0] === 254 && buffer[1] === 255) return "UTF-16BE"
  let littleEndian = 0
  let bigEndian = 0
  const samples = Math.min(50, Math.floor(buffer.length / 2))
  for (let index = 0; index < samples * 2; index += 2) {
    if (index + 1 >= buffer.length) break
    if (buffer[index + 1] === 0 && isPrintable(buffer[index] ?? 0)) littleEndian += 1
    if (buffer[index] === 0 && isPrintable(buffer[index + 1] ?? 0)) bigEndian += 1
  }
  if (littleEndian > samples * 0.8) return "UTF-16LE"
  if (bigEndian > samples * 0.8) return "UTF-16BE"
  return null
}

function detectUtf32(buffer: Buffer): string | null {
  if (buffer.length < 8) return null
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 254 && buffer[3] === 255) return "UTF-32BE"
  if (buffer[0] === 255 && buffer[1] === 254 && buffer[2] === 0 && buffer[3] === 0) return "UTF-32LE"
  let bigEndian = 0
  let littleEndian = 0
  const samples = Math.min(50, Math.floor(buffer.length / 4))
  for (let index = 0; index < samples * 4; index += 4) {
    if (index + 3 >= buffer.length) break
    if (buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 0 && isPrintable(buffer[index + 3] ?? 0)) bigEndian += 1
    if (buffer[index + 1] === 0 && buffer[index + 2] === 0 && buffer[index + 3] === 0 && isPrintable(buffer[index] ?? 0)) littleEndian += 1
  }
  if (bigEndian > samples * 0.8) return "UTF-32BE"
  if (littleEndian > samples * 0.8) return "UTF-32LE"
  return null
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= UTF8_BOM_BYTES.length && buffer.subarray(0, UTF8_BOM_BYTES.length).equals(UTF8_BOM_BYTES)
}

async function readFirstBytes(filePath: string): Promise<Buffer> {
  const fileHandle = await open(filePath, "r")
  try {
    const buffer = Buffer.allocUnsafe(HEADER_BYTES)
    const { bytesRead } = await fileHandle.read(buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await fileHandle.close()
  }
}

function rememberEncoding(filePath: string, encoding: string): void {
  fileEncodings.delete(filePath)
  fileEncodings.set(filePath, encoding)
  if (fileEncodings.size <= MAX_REMEMBERED_ENCODINGS) return
  const oldest = fileEncodings.keys().next().value
  if (oldest !== undefined) fileEncodings.delete(oldest)
}

/** Strict UTF-8 first, then Latin-1: a file that is not valid UTF-8 is still readable, byte for byte. */
function decodeWithUtf8Fallback(buffer: Buffer): { text: string; encoding: string } {
  try {
    return { text: UTF8_DECODER.decode(buffer), encoding: UTF8_ENCODING }
  } catch {
    return { text: LATIN1_DECODER.decode(buffer), encoding: LATIN1_ENCODING }
  }
}

function decode(buffer: Buffer, encoding: string): { text: string; encoding: string } {
  const normalized = normalizeEncodingName(encoding)
  if (normalized === UTF8_ENCODING || normalized === UTF8_BOM_ENCODING || normalized === "ascii") {
    const decoded = decodeWithUtf8Fallback(buffer)
    if (normalized === UTF8_BOM_ENCODING && decoded.encoding === UTF8_ENCODING) {
      return { text: decoded.text, encoding: UTF8_BOM_ENCODING }
    }
    return decoded
  }
  if (normalized === LATIN1_ENCODING) return { text: LATIN1_DECODER.decode(buffer), encoding: LATIN1_ENCODING }
  try {
    const iconvEncoding = mapToIconvEncoding(normalized)
    if (iconv.encodingExists(iconvEncoding)) return { text: iconv.decode(buffer, iconvEncoding), encoding: normalized }
  } catch {
    // Fall through to the UTF-8/Latin-1 path: a decoder that throws must not make a file unreadable.
  }
  return decodeWithUtf8Fallback(buffer)
}
