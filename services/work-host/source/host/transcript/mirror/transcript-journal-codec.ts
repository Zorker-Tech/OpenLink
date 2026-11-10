/**
 * The journal a mirrored transcript is written through.
 *
 * A checkpoint records the turns it covers, and steps that arrive before their checkpoint are held as deferred until
 * the checkpoint lands; a journal whose contents do not match the digest it carries is reported as corrupt rather
 * than read, and a write that cannot be made is reported with what it was writing.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

export class TranscriptOccurrenceConflictError extends Error { override name = "TranscriptOccurrenceConflictError"; }
export class TranscriptJournalCorruptionError extends Error { override name = "TranscriptJournalCorruptionError"; }
export class TranscriptJournalWriteError extends Error { override name = "TranscriptJournalWriteError"; }

export interface TranscriptCheckpoint { turns: readonly Uint8Array[] }
export interface DeferredTranscriptStep { turnIndex: number; stepIndex: number }
export interface PendingTranscriptCheckpoint { version: 1; previousCheckpointHash: string; checkpointHash: string; appendOffset: number; fileDevice: string; fileInode: string; lines: string[]; cursor: { turnCount: number; deferredStep?: DeferredTranscriptStep } }

/** The digest a journal is keyed by: the algorithm, and how its bytes are written out. */
const DIGEST_ALGORITHM = "sha256";
const DIGEST_ENCODING = "hex";

/** A digest as the journal writes it: sixty-four lower-case hex characters, and nothing else. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The code a file that is not there reports, which is not a journal failure. */
const MISSING_FILE_CODE = "ENOENT";

/** What a journal that cannot be read or written says, in the words stored tools already know. */
const CHECKPOINT_JSON_INVALID = "pending transcript checkpoint is not valid JSON";
const CHECKPOINT_NOT_OBJECT = "pending transcript checkpoint is not an object";
const CHECKPOINT_METADATA_INVALID = "pending transcript checkpoint metadata is invalid";
const CHECKPOINT_CURSOR_INVALID = "pending transcript checkpoint cursor is invalid";
const DEFERRED_CURSOR_INVALID = "transcript deferred cursor is invalid";
const PENDING_LINE_INVALID = "pending transcript line is invalid";
const PENDING_LINE_ENVELOPE_INVALID = "pending transcript line does not use the legacy message envelope";
const WRITE_STALLED = "transcript JSONL write made no progress";

/** A value shaped like the journal's records: an object that is not an array. */
function isJournalRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** A count the journal can carry: a whole number that is not negative. */
function isJournalCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A digest as the journal writes it. */
function isJournalDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** A line that still uses the message envelope the mirror has always written. */
function hasLegacyMessageEnvelope(value: unknown): boolean {
  return isJournalRecord(value) && "role" in value && "message" in value;
}

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash(DIGEST_ALGORITHM).update(value).digest(DIGEST_ENCODING);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** The digest of one turn, or nothing when the checkpoint does not reach that far back. */
function turnDigest(turns: readonly Uint8Array[], index: number): string {
  const turn = turns.at(index);
  return turn == null ? "" : Buffer.from(turn).toString("hex");
}

export function checkpointIdentity(checkpoint: TranscriptCheckpoint): string {
  const turns = checkpoint.turns;
  return sha256(`${turns.length}:${turnDigest(turns, -2)}:${turnDigest(turns, -1)}`);
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === MISSING_FILE_CODE;
}

export function fileIdentity(stats: Stats | { size: number | bigint; dev: number | bigint; ino: number | bigint }) {
  return { size: Number(stats.size), device: String(stats.dev), inode: String(stats.ino) };
}

export function parseDeferredStep(value: unknown): DeferredTranscriptStep | undefined {
  if (value == null) return undefined;
  if (!isJournalRecord(value)) throw new TranscriptJournalCorruptionError(DEFERRED_CURSOR_INVALID);
  const { turnIndex, stepIndex } = value;
  if (!isJournalCount(turnIndex) || !isJournalCount(stepIndex)) throw new TranscriptJournalCorruptionError(DEFERRED_CURSOR_INVALID);
  return { turnIndex, stepIndex };
}

/** The checkpoint's JSON, or the corruption the platform reports when the text is not JSON. */
function parseCheckpointJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new TranscriptJournalCorruptionError(CHECKPOINT_JSON_INVALID, { cause: error });
  }
}

/** Whether the record carries every field a pending checkpoint is written with. */
function hasCheckpointMetadata(record: Record<string, unknown>): boolean {
  return record.version === 1
    && isJournalDigest(record.previousCheckpointHash)
    && isJournalDigest(record.checkpointHash)
    && isJournalCount(record.appendOffset)
    && typeof record.fileDevice === "string"
    && typeof record.fileInode === "string"
    && Array.isArray(record.lines)
    && isJournalRecord(record.cursor);
}

/** One stored line, still as it was written, once it is known to be a legacy message line. */
function parsePendingLine(line: unknown): string {
  if (typeof line !== "string") throw new TranscriptJournalCorruptionError(PENDING_LINE_INVALID);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TranscriptJournalCorruptionError(PENDING_LINE_INVALID);
  }
  if (!hasLegacyMessageEnvelope(parsed)) throw new TranscriptJournalCorruptionError(PENDING_LINE_ENVELOPE_INVALID);
  return line;
}

/** The cursor a pending checkpoint resumes at: its turn count, and the deferred step if one is held. */
function parseCheckpointCursor(record: Record<string, unknown>): PendingTranscriptCheckpoint["cursor"] {
  const cursor = record.cursor as Record<string, unknown>;
  if (!isJournalCount(cursor.turnCount)) throw new TranscriptJournalCorruptionError(CHECKPOINT_CURSOR_INVALID);
  const deferredStep = parseDeferredStep(cursor.deferredStep);
  return deferredStep === undefined ? { turnCount: cursor.turnCount } : { turnCount: cursor.turnCount, deferredStep };
}

export function parsePendingCheckpoint(raw: string): PendingTranscriptCheckpoint {
  const parsed = parseCheckpointJson(raw);
  if (!isJournalRecord(parsed)) throw new TranscriptJournalCorruptionError(CHECKPOINT_NOT_OBJECT);
  if (!hasCheckpointMetadata(parsed)) throw new TranscriptJournalCorruptionError(CHECKPOINT_METADATA_INVALID);
  const lines = (parsed.lines as readonly unknown[]).map((line) => parsePendingLine(line));
  const cursor = parseCheckpointCursor(parsed);
  return {
    version: 1,
    previousCheckpointHash: parsed.previousCheckpointHash as string,
    checkpointHash: parsed.checkpointHash as string,
    appendOffset: parsed.appendOffset as number,
    fileDevice: parsed.fileDevice as string,
    fileInode: parsed.fileInode as string,
    lines,
    cursor,
  };
}

export async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<number> {
  let written = 0;
  while (written < bytes.byteLength) {
    const remaining = bytes.byteLength - written;
    const result = await handle.write(bytes, written, remaining, position + written);
    if (result.bytesWritten === 0) throw new TranscriptJournalWriteError(WRITE_STALLED);
    written += result.bytesWritten;
  }
  return position + written;
}

/** The envelope the mirror has always written a message in, whichever content it carries. */
function legacyMessageEnvelope<Role extends "user" | "assistant" | "tool">(role: Role, content: unknown[]) {
  return { role, message: { content } };
}

export function formatTextLine(role: "user" | "assistant", text: string): string | null {
  if (text.length === 0) return null;
  return JSON.stringify(legacyMessageEnvelope(role, [{ type: "text", text }]));
}

export function formatToolLine(role: "assistant" | "tool", name: string, payload: unknown): string {
  const content = role === "assistant" ? [{ type: "tool_use", name, input: payload }] : [{ type: "tool_result", name, result: payload }];
  return JSON.stringify(legacyMessageEnvelope(role, content));
}
