/**
 * Reading a file for the model.
 *
 * What a read means depends on what the file is. Text is decoded with the encoding that fits, then cut to the range the
 * caller asked for; an image is resized if it is larger than the model can take; a PDF and a video are handed over as
 * data rather than decoded; and bytes that name a format the model cannot read are refused instead of being shown as
 * mojibake. A terminal's output is its own case: it is a file of records rather than of text, so its records are
 * decoded and its footer is checked, which is what tells a command's output from a file that merely lives beside it.
 *
 * Every filesystem step is bounded by a watchdog, so a filesystem that hangs becomes an error rather than a turn that
 * never ends. The failures a reader can expect — the file is missing, the user may not read it, the path is a directory —
 * each have their own answer, so the model can act on the difference.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { TextDecoder } from "node:util";
import * as iconv from "iconv-lite";

import type { Context } from "../context/context.ts";
import { createLogger } from "../context/logging.ts";
import { isAgentToolOutputFile, isTerminalFilePath } from "../utils/managed-paths.ts";
import { resizeImageBufferIfNeeded } from "../utils/image-resize.ts";
import { resolvePath } from "../utils/paths.ts";
import { countLines, getFormatForFile, isVideoFilePath, readText } from "../utils/text-encoding.ts";
import { scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess, type McpStateAccessor } from "./mcp-disk-freshness-on-access.ts";

const PDF_EXTENSION = ".pdf";
const MAX_TEXT_SIZE = 8 * 1024 * 1024;
const STREAMING_READ_CHUNK_BYTES = 64 * 1024;
const MAX_FILE_ENCODINGS = 100;
const logger = createLogger("LocalReadExecutor");
const TERMINAL_DELIMITER = Buffer.from("\n---\n");
const TERMINAL_FOOTER_MAX_BYTES = 4096;
const TERMINAL_DETECT_MIN_PAIRED_MATCHES = 8;
const FILE_TO_ENCODING = new Map<string, string>();

/** The bytes that name a binary format the model cannot read, in the order the formats are checked. */
const KNOWN_BINARY_MAGIC_PREFIXES = [
  Buffer.from("%PDF-", "ascii"), Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]),
  Buffer.from([80, 75, 3, 4]), Buffer.from([80, 75, 5, 6]), Buffer.from([80, 75, 7, 8]),
  Buffer.from([127, 69, 76, 70]), Buffer.from([254, 237, 250, 206]), Buffer.from([254, 237, 250, 207]),
  Buffer.from([206, 250, 237, 254]), Buffer.from([207, 250, 237, 254]), Buffer.from([77, 90, 144]),
  Buffer.from([0, 97, 115, 109]), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([255, 216, 255]),
  Buffer.from("GIF87a", "ascii"), Buffer.from("GIF89a", "ascii"), Buffer.from("SQLite format 3\0", "ascii"),
  Buffer.from([31, 139]), Buffer.from("BZh", "ascii"), Buffer.from([253, 55, 122, 88, 90, 0]),
  Buffer.from([40, 181, 47, 253]), Buffer.from([55, 122, 188, 175, 39, 28]),
  Buffer.from([82, 97, 114, 33, 26, 7, 0]), Buffer.from([82, 97, 114, 33, 26, 7, 1, 0]),
];

/** The one thing a read needs from the platform's permission service. */
export interface ReadPermissions { shouldBlockRead(path: string): Promise<boolean> | boolean }

/** What the caller asked to read, and how much of it. */
export interface LocalReadArgs {
  readonly path: string;
  readonly toolCallId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly encodingHint?: string;
}

export type LocalReadOutcome =
  | {
      readonly kind: "success";
      readonly path: string;
      readonly output: { readonly kind: "text"; readonly text: string } | { readonly kind: "data"; readonly bytes: Uint8Array };
      readonly totalLines: number;
      readonly fileSize: number;
      readonly truncated: boolean;
      readonly rangeApplied: boolean;
    }
  | { readonly kind: "invalid_file"; readonly path: string; readonly reason: string }
  | { readonly kind: "permission_denied"; readonly path: string }
  | { readonly kind: "not_found"; readonly path: string }
  | { readonly kind: "error"; readonly path: string; readonly error: string }

/** What the executor may be built with: the MCP state to refresh and the switch for the streaming reader. */
export interface LocalReadOptions {
  readonly mcpStateAccessor?: McpStateAccessor;
  readonly useStreamingRead?: () => Promise<boolean>;
}

/** Run one filesystem step under a watchdog that reports the step that overran. */
async function bounded<T>(ctx: Context, step: string, milliseconds: number, operation: () => Promise<T> | T): Promise<T> {
  const timer = setTimeout(() => logger.warn(ctx, `[watchdog, LocalReadExecutor] ${step} still not completed after ${milliseconds}ms`), milliseconds);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a path names a PDF, by its extension. */
function isPdfFilePath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === PDF_EXTENSION;
}

/** Whether a byte can appear in printable text: ASCII, tab, newline or carriage return. */
function isPrintableByte(byte: number): boolean {
  return byte >= 32 && byte <= 126 || byte === 9 || byte === 10 || byte === 13;
}

// ---------------------------------------------------------------------------------------------
// Terminal records: a frontmatter block, a body in some encoding, and a footer that says which
// ---------------------------------------------------------------------------------------------

/** Where a terminal file's frontmatter ends, or zero when it has none. */
function terminalFrontmatterEnd(buffer: Buffer): number {
  if (buffer.length < 5 || buffer[0] !== 45 || buffer[1] !== 45 || buffer[2] !== 45 || buffer[3] !== 10) return 0;
  const delimiter = buffer.indexOf(TERMINAL_DELIMITER, 4);
  return delimiter === -1 ? 0 : delimiter + TERMINAL_DELIMITER.length;
}

/** The encoding a terminal body is written in: a byte-order mark when there is one, else a pairing heuristic. */
function terminalBodyEncoding(body: Buffer): "utf-8" | "utf-16le" | "utf-16be" {
  if (body.length >= 2) {
    if (body[0] === 255 && body[1] === 254) return "utf-16le";
    if (body[0] === 254 && body[1] === 255) return "utf-16be";
  }
  const sampleLength = Math.min(4096, body.length);
  if (sampleLength < 16) return "utf-8";
  let littleEndianPairs = 0;
  let bigEndianPairs = 0;
  for (let index = 0; index + 1 < sampleLength; index += 2) {
    const low = body[index]!;
    const high = body[index + 1]!;
    if (high === 0 && isPrintableByte(low)) littleEndianPairs += 1;
    if (low === 0 && isPrintableByte(high)) bigEndianPairs += 1;
  }
  if (littleEndianPairs >= TERMINAL_DETECT_MIN_PAIRED_MATCHES && littleEndianPairs >= 4 * Math.max(1, bigEndianPairs)) return "utf-16le";
  if (bigEndianPairs >= TERMINAL_DETECT_MIN_PAIRED_MATCHES && bigEndianPairs >= 4 * Math.max(1, littleEndianPairs)) return "utf-16be";
  return "utf-8";
}

/** A footer is printable text of two or three lines: an exit code or error, an optional elapsed time, and when it ended. */
function isTerminalFooter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 10 && (code < 32 || code > 126)) return false;
  }
  const footerLines = text.split("\n").filter(line => line.length > 0);
  if (footerLines.length < 2 || footerLines.length > 3) return false;
  if (!/^(exit_code: (?:-?\d+|unknown)|error: .+)$/.test(footerLines[0]!)) return false;
  if (!footerLines.at(-1)!.startsWith("ended_at: ")) return false;
  return footerLines.length !== 3 || /^elapsed_ms: \d+$/.test(footerLines[1]!);
}

/** Where a terminal file's footer starts, or the buffer's length when its tail is not a valid footer. */
function terminalFooterStart(buffer: Buffer, minimumStart: number): number {
  const length = buffer.length;
  if (length < TERMINAL_DELIMITER.length * 2 || buffer[length - 1] !== 10 || buffer[length - 2] !== 45 || buffer[length - 3] !== 45 || buffer[length - 4] !== 45 || buffer[length - 5] !== 10) return length;
  const opening = buffer.lastIndexOf(TERMINAL_DELIMITER, length - TERMINAL_DELIMITER.length - 1);
  if (opening === -1 || opening < Math.max(minimumStart, length - TERMINAL_FOOTER_MAX_BYTES)) return length;
  const footerBody = buffer.subarray(opening + TERMINAL_DELIMITER.length, length - 4).toString("utf8");
  return isTerminalFooter(footerBody) ? opening : length;
}

/** The text of a terminal file: its frontmatter, its decoded body with any byte-order mark dropped, and its footer. */
function decodeTerminalFile(raw: Buffer): string {
  const frontmatterEnd = terminalFrontmatterEnd(raw);
  const frontmatter = frontmatterEnd > 0 ? raw.subarray(0, frontmatterEnd).toString("utf8") : "";
  const footerStart = terminalFooterStart(raw, frontmatterEnd);
  const footer = footerStart < raw.length ? raw.subarray(footerStart).toString("utf8") : "";
  const body = raw.subarray(frontmatterEnd, footerStart);
  const encoding = terminalBodyEncoding(body);
  let text: string;
  if (encoding === "utf-16le") {
    text = body.toString("utf16le");
  } else if (encoding === "utf-16be") {
    const swapped = Buffer.from(body.subarray(0, body.length - body.length % 2));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else {
    text = body.toString("utf8");
  }
  return frontmatter + (text.charCodeAt(0) === 65279 ? text.slice(1) : text) + footer;
}

// ---------------------------------------------------------------------------------------------
// What a file's bytes are
// ---------------------------------------------------------------------------------------------

/** Whether a buffer begins with a prefix. */
function bufferStartsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

/** Whether a buffer's first bytes name one of the binary formats the model cannot read. */
function looksLikeKnownBinaryFormat(buffer: Buffer): boolean {
  return KNOWN_BINARY_MAGIC_PREFIXES.some(prefix => bufferStartsWith(buffer, prefix));
}

/** The answer for a file whose bytes name a format the model cannot read: refused, with the format named. */
function binaryRejection(path: string): LocalReadOutcome {
  const extension = extname(path).toLowerCase();
  const reason = extension === "" ? "Binary files without an extension are not supported by the read executor" : `Binary files of type ${extension} are not supported by the read executor`;
  return { kind: "invalid_file", path, reason };
}

/** The answer for a file that exists but is not a file: a directory, or neither. */
function notAFile(path: string, reason: string): LocalReadOutcome {
  return { kind: "invalid_file", path, reason };
}

/** The answer for a file that was read: content or data, with the file's size and how much of it was kept. */
function readSuccess(path: string, fileSize: number, output: { case: "content"; value: string } | { case: "data"; value: Uint8Array }, totalLines: number, truncated: boolean, rangeApplied: boolean): LocalReadOutcome {
  return {
    kind: "success",
    path,
    output: output.case === "content" ? { kind: "text", text: output.value } : { kind: "data", bytes: output.value },
    totalLines,
    fileSize,
    truncated,
    rangeApplied,
  };
}

// ---------------------------------------------------------------------------------------------
// Cutting a text read to the range the caller asked for
// ---------------------------------------------------------------------------------------------

/** The line range a read applies, or null when no range was asked for. */
interface LineRange { readonly start: number; readonly end: number }

/** The range the caller's offset and limit mean, or null when they ask for the whole file. */
function requestedLineRange(args: LocalReadArgs, totalLines: number): LineRange | null {
  if (args.offset === undefined && args.limit === undefined) return null;
  const offset = args.offset ?? 1;
  const limit = args.limit ?? (offset < 0 ? Math.abs(offset) : totalLines);
  const start = offset < 0 ? Math.max(0, totalLines + offset) : Math.max(0, offset - 1);
  return start >= totalLines ? null : { start, end: Math.min(totalLines, start + limit) };
}

/** A text read cut to the caller's range; an empty file or an out-of-range start keeps the whole content. */
function applyRange(content: string, totalLines: number, args: LocalReadArgs): { content: string; rangeApplied: boolean } {
  const range = requestedLineRange(args, totalLines);
  if (range === null || content === "") return { content, rangeApplied: false };
  return { content: content.split("\n").slice(range.start, range.end).join("\n"), rangeApplied: true };
}

/** Text that grows under a character budget and remembers whether it was cut. */
interface BoundedText { readonly text: string; readonly truncated: boolean }

/** Append text to a bounded read, keeping the budget and marking the read truncated when it overruns. */
function appendBounded(current: BoundedText, addition: string, maxChars = MAX_TEXT_SIZE): BoundedText {
  if (addition.length === 0) return current;
  const remaining = maxChars - current.text.length;
  if (remaining <= 0) return { text: current.text, truncated: true };
  if (addition.length > remaining) return { text: current.text + addition.slice(0, remaining), truncated: true };
  return { text: current.text + addition, truncated: current.truncated };
}

/** One line kept by a streaming read, and whether a newline followed it. */
interface RetainedLine { readonly line: BoundedText; readonly hasNewline: boolean }

/** The text a set of retained lines adds up to, with CRLF pairs normalized when the file mostly uses them. */
function appendRetainedLines(current: BoundedText, lines: readonly RetainedLine[], normalizeCrlf: boolean): BoundedText {
  let result = current;
  lines.forEach((retained, index) => {
    const line = normalizeCrlf && retained.hasNewline && retained.line.text.endsWith("\r")
      ? { ...retained.line, text: retained.line.text.slice(0, -1) }
      : retained.line;
    if (index > 0) result = appendBounded(result, "\n");
    result = appendBounded(result, line.text);
    if (line.truncated) result = { text: result.text, truncated: true };
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------------------------

/** Remember the encoding a path turned out to have, keeping the cache bounded. */
function cacheEncoding(path: string, encoding: string): void {
  if (FILE_TO_ENCODING.has(path)) FILE_TO_ENCODING.delete(path);
  FILE_TO_ENCODING.set(path, encoding);
  if (FILE_TO_ENCODING.size > MAX_FILE_ENCODINGS) {
    const oldest = FILE_TO_ENCODING.keys().next().value;
    if (oldest !== undefined) FILE_TO_ENCODING.delete(oldest);
  }
}

/** An encoding name folded to this platform's spelling. */
function normalizedEncoding(encoding: string): string {
  const normalized = encoding.toLowerCase();
  if (normalized === "utf-8") return "utf8";
  if (normalized === "utf-8-bom" || normalized === "utf-8 bom") return "utf8bom";
  if (normalized === "latin-1") return "latin1";
  return normalized;
}

/** The encoding name iconv knows: the byte-order mark is metadata rather than an iconv encoding. */
function iconvEncoding(encoding: string): string {
  const normalized = normalizedEncoding(encoding);
  return normalized === "utf8bom" ? "utf8" : normalized;
}

/** Raised when the strict UTF-8 decoder meets bytes that are not UTF-8, so the stream can fall back to latin1. */
class InvalidUtf8Error extends Error {
  constructor() {
    super("Invalid UTF-8 while streaming read");
    this.name = "InvalidUtf8Error";
  }
}

/** How a streaming read decodes its file: strict UTF-8 with a fallback, or an iconv decoder. */
type DecoderConfig = { readonly kind: "strictUtf8"; readonly cacheEncoding: string } | { readonly kind: "iconv"; readonly decoderEncoding: string; readonly cacheEncoding: string };

/** The decoder a streaming read starts with: the hint, the cached encoding, or the format's own. */
function streamingDecoderConfig(path: string, format: { encoding: string }, encodingHint: string | undefined): DecoderConfig {
  const requested = normalizedEncoding(encodingHint ?? FILE_TO_ENCODING.get(path) ?? format.encoding);
  const decoder = iconvEncoding(requested);
  if (decoder === "utf8") return { kind: "strictUtf8", cacheEncoding: "utf8" };
  if (iconv.encodingExists(decoder)) return { kind: "iconv", decoderEncoding: decoder, cacheEncoding: requested };
  return { kind: "strictUtf8", cacheEncoding: "utf8" };
}

/** The chunks of a file decoded as text, strictly for UTF-8 and through iconv for anything else. */
async function* decodedFileChunks(ctx: Context, path: string, config: DecoderConfig): AsyncGenerator<string> {
  if (config.kind === "iconv") {
    const decoded = createReadStream(path, { highWaterMark: STREAMING_READ_CHUNK_BYTES, signal: ctx.signal }).pipe(iconv.decodeStream(config.decoderEncoding));
    for await (const chunk of decoded) yield typeof chunk === "string" ? chunk : String(chunk);
    return;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const stream = createReadStream(path, { highWaterMark: STREAMING_READ_CHUNK_BYTES, signal: ctx.signal });
  try {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk as Buffer, { stream: true });
      if (text.length > 0) yield text;
    }
    const finalText = decoder.decode();
    if (finalText.length > 0) yield finalText;
  } catch (error) {
    if (error instanceof TypeError) throw new InvalidUtf8Error();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The streaming read, which counts every line and keeps only the bounded parts it needs
// ---------------------------------------------------------------------------------------------

/** The answer a streaming read gives. */
interface StreamedText { readonly content: string; readonly totalLines: number; readonly truncated: boolean; readonly rangeApplied: boolean }

/** How a streaming read starts: the range it was asked for. */
interface StreamPlan {
  readonly hasRange: boolean;
  readonly negativeOffset: boolean;
  readonly positiveStart: number;
  readonly positiveEnd: number | undefined;
  readonly tailCapacity: number;
}

/** The plan a streaming read follows from the caller's offset and limit. */
function streamingPlan(args: LocalReadArgs): StreamPlan {
  const offset = args.offset ?? 1;
  return {
    hasRange: args.offset !== undefined || args.limit !== undefined,
    negativeOffset: offset < 0,
    positiveStart: Math.max(0, offset - 1),
    positiveEnd: args.limit === undefined ? undefined : Math.max(0, offset - 1) + args.limit,
    tailCapacity: offset < 0 ? Math.abs(offset) : 0,
  };
}

/** A line kept only as far as the remaining budget allows. */
function retainLineWithinBudget(line: BoundedText, remaining: number): BoundedText {
  return line.text.length <= remaining ? line : { text: line.text.slice(0, remaining), truncated: true };
}

/** Read a text file as a stream, counting every line and keeping the bounded selections the caller asked for. */
async function readTextStreaming(ctx: Context, path: string, format: { encoding: string }, args: LocalReadArgs): Promise<StreamedText> {
  const config = streamingDecoderConfig(path, format, args.encodingHint);
  try {
    return await streamWithDecoder(ctx, path, args, config);
  } catch (error) {
    if (error instanceof InvalidUtf8Error) return streamWithDecoder(ctx, path, args, { kind: "iconv", decoderEncoding: "latin1", cacheEncoding: "latin1" });
    throw error;
  }
}

/** Read a text file through one decoder, keeping the parts of the range the caller asked for. */
async function streamWithDecoder(ctx: Context, path: string, args: LocalReadArgs, config: DecoderConfig): Promise<StreamedText> {
  const plan = streamingPlan(args);
  const fallback: RetainedLine[] = [];
  const selected: RetainedLine[] = [];
  const tail: RetainedLine[] = [];
  const bytes = { fallback: 0, selected: 0, tail: 0 };
  const truncated = { fallback: false, selected: false, tail: false };
  let pending: BoundedText = { text: "", truncated: false };
  let totalLines = 0;
  let crlfCount = 0;
  let lfCount = 0;
  let sawFirstChunk = false;
  let hadBom = false;

  /** Drop a byte-order mark from the very start of the stream, remembering that the file had one. */
  const normalizeFirstChunk = (chunk: string): string => {
    if (sawFirstChunk || chunk.length === 0) return chunk;
    sawFirstChunk = true;
    if (chunk.charCodeAt(0) !== 65279) return chunk;
    hadBom = true;
    return chunk.slice(1);
  };

  const appendLine = (target: "fallback" | "selected", line: BoundedText, hasNewline: boolean): void => {
    const lines = target === "fallback" ? fallback : selected;
    const used = target === "fallback" ? bytes.fallback : bytes.selected;
    const separator = lines.length > 0 ? 1 : 0;
    let remaining = MAX_TEXT_SIZE - used;
    if (separator > 0) {
      if (remaining <= 0) {
        if (target === "fallback") truncated.fallback = true;
        else truncated.selected = true;
        return;
      }
      remaining -= separator;
    }
    const retained = retainLineWithinBudget(line, remaining);
    lines.push({ line: retained, hasNewline });
    if (target === "fallback") {
      bytes.fallback += separator + retained.text.length;
      if (line.truncated || retained.truncated) truncated.fallback = true;
    } else {
      bytes.selected += separator + retained.text.length;
      if (line.truncated || retained.truncated) truncated.selected = true;
    }
  };

  const finishLine = (line: BoundedText, hasNewline: boolean): void => {
    if (hasNewline) {
      if (line.text.endsWith("\r")) crlfCount += 1;
      else lfCount += 1;
    }
    appendLine("fallback", line, hasNewline);
    const lineIndex = totalLines;
    if (!plan.negativeOffset) {
      const inRange = plan.hasRange && lineIndex >= plan.positiveStart && (plan.positiveEnd === undefined || lineIndex < plan.positiveEnd);
      if (inRange) appendLine("selected", line, hasNewline);
    } else if (plan.tailCapacity > 0) {
      tail.push({ line, hasNewline });
      bytes.tail += line.text.length + 1;
      while (tail.length > plan.tailCapacity) {
        const dropped = tail.shift();
        if (dropped !== undefined) bytes.tail -= dropped.line.text.length + 1;
      }
      while (tail.length > 1 && bytes.tail > MAX_TEXT_SIZE) {
        const dropped = tail.shift();
        if (dropped !== undefined) {
          bytes.tail -= dropped.line.text.length + 1;
          truncated.tail = true;
        }
      }
    }
    totalLines += 1;
  };

  for await (const rawChunk of decodedFileChunks(ctx, path, config)) {
    const parts = normalizeFirstChunk(rawChunk).split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      pending = appendBounded(pending, parts[index]!);
      if (index < parts.length - 1) {
        finishLine(pending, true);
        pending = { text: "", truncated: false };
      }
    }
  }
  finishLine(pending, false);

  const normalizeCrlf = crlfCount + lfCount > 0 && crlfCount / (crlfCount + lfCount) * 100 >= 5;
  cacheEncoding(path, config.cacheEncoding === "utf8" && hadBom ? "utf8bom" : config.cacheEncoding);
  const full = appendRetainedLines({ text: "", truncated: truncated.fallback }, fallback, normalizeCrlf);
  if (!plan.hasRange) return { content: full.text, totalLines, truncated: full.truncated, rangeApplied: false };
  if (full.text === "") return { content: "", totalLines, truncated: false, rangeApplied: false };
  if (plan.negativeOffset) {
    const limit = args.limit ?? plan.tailCapacity;
    const tailText = appendRetainedLines({ text: "", truncated: truncated.tail }, tail.slice(0, limit), normalizeCrlf);
    return { content: tailText.text, totalLines, truncated: tailText.truncated, rangeApplied: true };
  }
  if (plan.positiveStart >= totalLines) return { content: full.text, totalLines, truncated: full.truncated, rangeApplied: false };
  const rangedText = appendRetainedLines({ text: "", truncated: truncated.selected }, selected, normalizeCrlf);
  return { content: rangedText.text, totalLines, truncated: rangedText.truncated, rangeApplied: true };
}

// ---------------------------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------------------------

/** Reading files for the model: one decision per kind of file, and one answer per kind of failure. */
export class LocalReadExecutor {
  private readonly mcpStateAccessor: McpStateAccessor | undefined;
  private readonly useStreamingRead: (() => Promise<boolean>) | undefined;

  constructor(private readonly permissionsService: ReadPermissions, private readonly workspacePath: string, options?: LocalReadOptions) {
    this.mcpStateAccessor = options?.mcpStateAccessor;
    this.useStreamingRead = options?.useStreamingRead;
  }

  /** Read one file, and answer with the content, the data or the reason it cannot be read. */
  async execute(ctx: Context, args: LocalReadArgs): Promise<LocalReadOutcome> {
    const path = resolvePath(args.path, this.workspacePath);
    const blocked = await bounded(ctx, "permissionsService.shouldBlockRead", 3_000, () => this.permissionsService.shouldBlockRead(path));
    if (blocked) return { kind: "permission_denied", path };
    if (this.mcpStateAccessor !== undefined) scheduleDiskMcpDiscoveryFreshnessOnMcpsPathAccess(ctx, this.mcpStateAccessor, path);
    try {
      const stats = await bounded(ctx, "stat", 3_000, () => stat(path));
      if (stats.isDirectory()) return notAFile(path, "Path is a directory, not a file");
      if (!stats.isFile()) return notAFile(path, "Path is neither a file nor a directory");
      const terminalPath = isTerminalFilePath(path);
      const agentToolPath = isAgentToolOutputFile(path);
      if (terminalPath || agentToolPath) return this.readRecordsFile(ctx, path, stats.size, args, agentToolPath && !terminalPath);
      const format = await bounded(ctx, "getFormatForFile", 3_000, () => getFormatForFile(path));
      if (format.isImageFile) return await this.readImage(ctx, path, stats.size);
      if (isPdfFilePath(path)) return await this.readData(ctx, path, stats.size, "readPdfBinary");
      if (format.isBinaryFile && isVideoFilePath(path)) return await this.readData(ctx, path, stats.size, "readBinaryFile");
      if (format.isBinaryFile) return binaryRejection(path);
      if (this.useStreamingRead !== undefined && await bounded(ctx, "useStreamingRead", 3_000, () => this.useStreamingRead!())) {
        const streamed = await bounded(ctx, "readTextStreaming", 7_000, () => readTextStreaming(ctx, path, format, args));
        return readSuccess(path, stats.size, { case: "content", value: streamed.content }, streamed.totalLines, streamed.truncated, streamed.rangeApplied);
      }
      return await this.readTextFile(ctx, path, stats.size, args);
    } catch (error) {
      return readFailure(path, error);
    }
  }

  /** An image is handed back as data, resized when the model cannot take it whole. */
  private async readImage(ctx: Context, path: string, size: number): Promise<LocalReadOutcome> {
    const image = await bounded(ctx, "resizeImageIfNeeded", 3_000, async () => resizeImageBufferIfNeeded(await readFile(path)));
    return readSuccess(path, size, { case: "data", value: image.data }, 0, false, false);
  }

  /** A PDF or a video is handed back as its bytes: the model decides what to do with it. */
  private async readData(ctx: Context, path: string, size: number, step: string): Promise<LocalReadOutcome> {
    const data = await bounded(ctx, step, 3_000, () => readFile(path));
    return readSuccess(path, size, { case: "data", value: data }, 0, false, false);
  }

  /** A text file read whole, with its range applied and the text budget enforced. */
  private async readTextFile(ctx: Context, path: string, size: number, args: LocalReadArgs): Promise<LocalReadOutcome> {
    const full = await bounded(ctx, "readText", 3_000, () => readText(path, args.encodingHint));
    const totalLines = await bounded(ctx, "countLines", 3_000, () => countLines(full));
    const ranged = applyRange(full, totalLines, args);
    const kept = ranged.content.length > MAX_TEXT_SIZE ? { content: ranged.content.substring(0, MAX_TEXT_SIZE), truncated: true } : { content: ranged.content, truncated: false };
    return readSuccess(path, size, { case: "content", value: kept.content }, totalLines, kept.truncated, ranged.rangeApplied);
  }

  /** A terminal or agent-tool record file: decoded as records, with the agent-tool bytes checked for binary formats. */
  private async readRecordsFile(ctx: Context, path: string, size: number, args: LocalReadArgs, checkBinary: boolean): Promise<LocalReadOutcome> {
    const raw = await bounded(ctx, "readTerminalFile", 3_000, () => readFile(path));
    if (checkBinary && looksLikeKnownBinaryFormat(raw)) return binaryRejection(path);
    const decoded = decodeTerminalFile(raw).replaceAll("\r\n", "\n");
    const totalLines = countLines(decoded);
    const ranged = applyRange(decoded, totalLines, args);
    const kept = ranged.content.length > MAX_TEXT_SIZE ? { content: ranged.content.substring(0, MAX_TEXT_SIZE), truncated: true } : { content: ranged.content, truncated: false };
    return readSuccess(path, size, { case: "content", value: kept.content }, totalLines, kept.truncated, ranged.rangeApplied);
  }
}

/** The answer for a read that failed: the failures a reader can expect, and one honest error for the rest. */
function readFailure(path: string, error: unknown): LocalReadOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { kind: "not_found", path };
  if (code === "EACCES" || code === "EPERM") return { kind: "permission_denied", path };
  return { kind: "error", path, error: error instanceof Error ? error.message : "Unknown error occurred" };
}
