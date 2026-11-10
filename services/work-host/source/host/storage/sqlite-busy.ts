/**
 * Retrying a store operation while another process holds the database.
 *
 * Busy and locked are worth waiting out; a corrupt or unreadable database is not, and neither is an I/O error, so the
 * two are told apart by their codes. The wait backs off and gives up after a bounded number of attempts.
 */
import { setTimeout as delay } from "node:timers/promises";

/** The sqlite result codes this module knows by name. */
export const SQLITE_BUSY = 5;
export const SQLITE_LOCKED = 6;
export const SQLITE_IOERR = 10;
export const SQLITE_CORRUPT = 11;
export const SQLITE_CANTOPEN = 14;
export const SQLITE_NOTADB = 26;

/** The extended bits of a sqlite code: the low byte is the result, the rest say more about it. */
const PRIMARY_CODE_MASK = 255;

/** The codes that mean another process is holding the database, which is worth waiting out. */
const BUSY_CODES: ReadonlySet<number> = new Set([SQLITE_BUSY, SQLITE_LOCKED]);

/** The messages sqlite writes when the database is held, for drivers that only surface the text. */
const BUSY_MESSAGES = ["database is locked", "database table is locked", "database schema is locked"];

/** The messages that mean the read itself failed. */
const IO_ERROR_MESSAGES = ["disk i/o error", "short read"];

/** The messages that mean the file could not be opened. */
const CANTOPEN_MESSAGES = ["unable to open database"];

/** The messages that mean the file is not a usable database. */
const CORRUPT_MESSAGES = ["malformed", "is not a database", "database disk image"];

/** The sqlite code an error carries, when it carries one. */
function resultCodeOf(error: Error): number | undefined {
  const value = (error as Error & { errcode?: unknown }).errcode;
  return typeof value === "number" ? value : undefined;
}

/** The result part of a sqlite code, without the extended bits. */
function primaryCodeOf(value: number | undefined): number | undefined {
  return value == null ? undefined : value & PRIMARY_CODE_MASK;
}

/** Whether the error's message is one of these, in any case. */
function messageMentions(error: Error, phrases: readonly string[]): boolean {
  const message = error.message.toLowerCase();
  return phrases.some((phrase) => message.includes(phrase));
}

/** Whether this error says the database is held by someone else. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (BUSY_CODES.has(resultCodeOf(error) as number)) return true;
  return messageMentions(error, BUSY_MESSAGES);
}

/** Whether this error says the read itself failed. */
export function isSqliteIoError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (primaryCodeOf(resultCodeOf(error)) === SQLITE_IOERR) return true;
  return messageMentions(error, IO_ERROR_MESSAGES);
}

/** Whether this error says the database file could not be opened. */
export function isSqliteCantOpenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (primaryCodeOf(resultCodeOf(error)) === SQLITE_CANTOPEN) return true;
  return messageMentions(error, CANTOPEN_MESSAGES);
}

/** Whether this error says the file is not a usable database. */
export function isSqliteCorruptError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const primary = primaryCodeOf(resultCodeOf(error));
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return true;
  return messageMentions(error, CORRUPT_MESSAGES);
}

/** How a retry waits: how many attempts, how long the first wait is, and how waiting is done. */
interface RetryPolicy {
  attempts?: number;
  baseDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
}

/** How many attempts a retry makes when the caller does not say. */
const DEFAULT_ATTEMPTS = 5;

/** How long the first wait is when the caller does not say. */
const DEFAULT_BASE_DELAY_MS = 100;

/** The operation, tried again while the database is busy, waiting longer after each refusal. */
export async function retrySqliteBusy<T>(operation: () => Promise<T> | T, options: RetryPolicy = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.delay ?? (async (ms: number) => { await delay(ms); });
  let lastBusy: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      lastBusy = error;
      if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastBusy;
}
