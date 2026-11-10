/**
 * The ledger of what a prompt accepted.
 *
 * A send carries a client nonce, and a retry of that send must not become a second send. So the platform keeps a small
 * ledger of nonces it has seen — what they carried (a digest of the input), what happened to them, and when — and this
 * file is that ledger.
 *
 * Three things make it more than a map:
 *
 * - **a nonce is either the same send or an error** — replaying a nonce with a different input is refused with
 *   `NONCE_DIGEST_MISMATCH`, and replaying a rejected one replays its rejection, so a client cannot "fix" a send by reusing
 *   its nonce;
 * - **the ledger is bounded, and says what it forgot** — past the cap a record is evicted and the ledger remembers an
 *   eviction horizon, so "not found" for an old nonce can be told apart from "never seen";
 * - **a ledger that cannot be written says so** — a write that fails opens a degraded window (a marker file, then a recorded
 *   window), and while any gap or window is open a lookup answers `unknown-durability` rather than `not-found`. A ledger
 *   that cannot be trusted must not be read as an empty one.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const NONCE_DIGEST_MISMATCH = "NONCE_DIGEST_MISMATCH";
export const SLATE_SEND_ACCEPTANCE_FILE_NAME = "send-acceptance.json";
export const MAX_RECORDS = 256;
export const DEGRADED_WINDOW_CAP = 8;
/** The same cap under the name the transcript extension and its tests already use. */
export const MAX_DEGRADED_WINDOWS = DEGRADED_WINDOW_CAP;

export class PromptAcceptanceRejectedError extends Error {}

export class PromptAcceptanceDigestMismatchError extends Error {
  readonly code = NONCE_DIGEST_MISMATCH;
  constructor(clientNonce: string) {
    super(`${NONCE_DIGEST_MISMATCH}: clientNonce ${clientNonce} was already accepted with a different input digest`);
    this.name = "PromptAcceptanceDigestMismatchError";
  }
}

export interface SendInput {
  agentId?: string;
  prompt: string;
  richText?: string;
  replyToId?: string;
  isFork?: boolean;
  attachmentPaths?: readonly string[];
  attachmentNames?: readonly string[];
}

/** The input, in one stable order: the digest is only useful if every field always lands in the same place. */
export function sendInputShape(input: SendInput): string {
  return JSON.stringify([
    input.agentId ?? null,
    input.prompt,
    input.richText ?? null,
    input.replyToId ?? null,
    input.isFork === true,
    [...(input.attachmentPaths ?? [])],
    [...(input.attachmentNames ?? [])],
  ]);
}

export function sendInputDigest(input: SendInput): string {
  return createHash("sha256").update(sendInputShape(input), "utf8").digest("hex");
}

export interface AcceptedSend {
  accountSlot: string;
  clientNonce: string;
  inputDigest: string;
  status: "accepted" | "rejected" | "pending";
  acceptedAtMs: number;
  agentId: string;
  echoEntryId: string | null;
  rejectionCode: string | null;
}

/** What the ledger knows it has forgotten: an eviction horizon, degraded windows, and a corrupt reset. */
export interface LedgerGaps {
  evictionHorizonMs: number | null;
  degradedWindows: Array<{ fromMs: number; toMs: number }>;
  corruptResetAtMs: number | null;
}

export const NO_GAPS: LedgerGaps = { evictionHorizonMs: null, degradedWindows: [], corruptResetAtMs: null };

export const SEND_STATUSES = ["accepted", "rejected", "pending"] as const;

/** Every gap update starts from the gaps that exist: a null ledger history is the empty one. */
function updateGaps(gaps: LedgerGaps | null, update: (base: LedgerGaps) => LedgerGaps): LedgerGaps {
  return update(gaps ?? NO_GAPS);
}

export function gapsAfterEviction(gaps: LedgerGaps | null, acceptedAtMs: number): LedgerGaps {
  return updateGaps(gaps, (base) => ({ ...base, evictionHorizonMs: Math.max(base.evictionHorizonMs ?? acceptedAtMs, acceptedAtMs) }));
}

/**
 * Past the cap the windows are collapsed rather than dropped: the oldest seven stay, and the last one grows to cover
 * itself and the new window. Dropping them would claim a durability the ledger does not have.
 */
export function gapsAfterDegradedWindow(gaps: LedgerGaps | null, window: { fromMs: number; toMs: number }): LedgerGaps {
  return updateGaps(gaps, (base) => {
    if (base.degradedWindows.length < DEGRADED_WINDOW_CAP) return { ...base, degradedWindows: [...base.degradedWindows, window] };
    const kept = base.degradedWindows.slice(0, -1);
    const last = base.degradedWindows.at(-1) ?? window;
    return { ...base, degradedWindows: [...kept, { fromMs: Math.min(last.fromMs, window.fromMs), toMs: Math.max(last.toMs, window.toMs) }] };
  });
}

export function gapsAfterCorruptReset(gaps: LedgerGaps | null, atMs: number): LedgerGaps {
  return updateGaps(gaps, (base) => ({ ...base, corruptResetAtMs: Math.max(base.corruptResetAtMs ?? atMs, atMs) }));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A record read back from disk, or null for anything the ledger cannot use. A record it cannot read is damage. */
export function readAcceptanceRecord(entry: unknown): AcceptedSend | null {
  if (typeof entry !== "object" || entry == null) return null;
  const candidate = entry as Record<string, unknown>;
  const usable =
    isNonEmptyString(candidate.accountSlot) &&
    isNonEmptyString(candidate.clientNonce) &&
    isNonEmptyString(candidate.inputDigest) &&
    isNonEmptyString(candidate.agentId) &&
    (SEND_STATUSES as readonly string[]).includes(String(candidate.status)) &&
    isFiniteNumber(candidate.acceptedAtMs);
  if (!usable) return null;
  return {
    accountSlot: candidate.accountSlot as string,
    clientNonce: candidate.clientNonce as string,
    inputDigest: candidate.inputDigest as string,
    status: candidate.status as AcceptedSend["status"],
    acceptedAtMs: candidate.acceptedAtMs as number,
    agentId: candidate.agentId as string,
    echoEntryId: typeof candidate.echoEntryId === "string" ? candidate.echoEntryId : null,
    rejectionCode: typeof candidate.rejectionCode === "string" ? candidate.rejectionCode : null,
  };
}

export const readRecordAlias = readAcceptanceRecord;

export function readGaps(value: unknown): LedgerGaps | "malformed" | null {
  if (value == null) return null;
  if (typeof value !== "object") return "malformed";
  const candidate = value as Record<string, unknown>;
  const horizon = candidate.evictionHorizonMs ?? null;
  const reset = candidate.corruptResetAtMs ?? null;
  if ((horizon !== null && !isFiniteNumber(horizon)) || (reset !== null && !isFiniteNumber(reset))) return "malformed";
  if (!Array.isArray(candidate.degradedWindows)) return "malformed";
  const windows: Array<{ fromMs: number; toMs: number }> = [];
  for (const entry of candidate.degradedWindows) {
    if (typeof entry !== "object" || entry == null) return "malformed";
    const window = entry as Record<string, unknown>;
    if (!isFiniteNumber(window.fromMs) || !isFiniteNumber(window.toMs)) return "malformed";
    windows.push({ fromMs: window.fromMs, toMs: window.toMs });
  }
  return { evictionHorizonMs: horizon as number | null, degradedWindows: windows, corruptResetAtMs: reset as number | null };
}

/**
 * The file as it was written, read back: every record it can use, the gaps it declared, and whether anything in it was
 * damaged. Damage never throws — a ledger with one bad record still knows about the others — but it is never silent.
 */
export function readAcceptanceSnapshot(raw: string | null): { records: AcceptedSend[]; gaps: LedgerGaps | null; damaged: boolean } {
  if (raw == null) return { records: [], gaps: null, damaged: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { records: [], gaps: null, damaged: true };
  }
  if (typeof value !== "object" || value == null || !Array.isArray((value as { records?: unknown }).records)) {
    return { records: [], gaps: null, damaged: true };
  }
  let damaged = false;
  const records: AcceptedSend[] = [];
  for (const entry of (value as { records: unknown[] }).records) {
    const record = readAcceptanceRecord(entry);
    if (record == null) damaged = true;
    else records.push(record);
  }
  const gaps = readGaps((value as { historyGaps?: unknown }).historyGaps);
  return gaps === "malformed" ? { records, gaps: null, damaged: true } : { records, gaps, damaged };
}

export function recordKey(accountSlot: string, clientNonce: string): string {
  return `${accountSlot}\0${clientNonce}`;
}

interface Loaded {
  records: Map<string, AcceptedSend>;
  gaps: LedgerGaps | null;
}

/** Which record to evict: the oldest completed one, and only if there is none, the oldest pending one. */
function firstEvictionCandidate(records: Map<string, AcceptedSend>): string | null {
  let pending: string | null = null;
  for (const [key, record] of records) {
    if (record.status === "pending") {
      pending ??= key;
      continue;
    }
    // The first completed record is the oldest one by insertion, which is all the ordering this ledger has.
    return key;
  }
  return pending;
}

export class PromptAcceptanceLedger {
  readonly filePath: string | null;
  private loaded: Loaded | null = null;
  private readonly nowMs: () => number;
  private degradedSinceMs: number | null = null;
  private markerMayExist = false;

  constructor(rootDir: string | null, nowMs: () => number = Date.now) {
    this.nowMs = nowMs;
    this.filePath = rootDir == null ? null : join(rootDir, SLATE_SEND_ACCEPTANCE_FILE_NAME);
  }

  dispose(): void {
    this.persist();
  }

  /**
   * A nonce the ledger knows, or a reason it cannot answer "no": a gap or an open degraded window means the record may have
   * existed and been forgotten, and that is not the same as never having been sent.
   */
  lookup(args: { accountSlot: string; clientNonce: string }): { outcome: "found"; record: AcceptedSend } | { outcome: "unknown-durability" | "not-found" } {
    const loaded = this.load();
    const record = loaded.records.get(recordKey(args.accountSlot, args.clientNonce));
    if (record != null) return { outcome: "found", record };
    return loaded.gaps != null || this.degradedSinceMs != null ? { outcome: "unknown-durability" } : { outcome: "not-found" };
  }

  admitSend(args: { accountSlot: string; clientNonce: string; inputDigest: string }): { kind: "dispatch" } | { kind: "duplicate"; record: AcceptedSend } {
    const found = this.lookup(args);
    if (found.outcome !== "found") return { kind: "dispatch" };
    if (found.record.inputDigest !== args.inputDigest) throw new PromptAcceptanceDigestMismatchError(args.clientNonce);
    if (found.record.status === "rejected") {
      throw new PromptAcceptanceRejectedError(`send rejected: ${found.record.rejectionCode ?? "unknown"} (replaying the nonce's original outcome)`);
    }
    return { kind: "duplicate", record: found.record };
  }

  recordPending(input: Omit<AcceptedSend, "status" | "acceptedAtMs" | "rejectionCode">): AcceptedSend {
    const key = recordKey(input.accountSlot, input.clientNonce);
    const existing = this.load().records.get(key);
    if (existing != null) {
      // The same nonce with a different input is the one thing this ledger must never accept silently.
      if (existing.inputDigest !== input.inputDigest) throw new PromptAcceptanceDigestMismatchError(input.clientNonce);
      return existing;
    }
    const record: AcceptedSend = { ...input, status: "pending", acceptedAtMs: this.nowMs(), rejectionCode: null };
    this.writeRecord(key, record);
    this.evictPastCap();
    this.persist();
    return record;
  }

  markAccepted(args: { accountSlot: string; clientNonce: string }): void {
    this.settle(args, (existing) => ({ ...existing, status: "accepted" }));
  }

  markRejected(args: { accountSlot: string; clientNonce: string; rejectionCode: string }): void {
    this.settle(args, (existing) => ({ ...existing, status: "rejected", rejectionCode: args.rejectionCode }));
  }

  /** A pending record is settled once; a record that is already settled keeps the outcome it had. */
  private settle(args: { accountSlot: string; clientNonce: string }, settled: (existing: AcceptedSend) => AcceptedSend): void {
    const key = recordKey(args.accountSlot, args.clientNonce);
    const existing = this.load().records.get(key);
    if (existing?.status !== "pending") return;
    this.writeRecord(key, settled(existing));
    this.persist();
  }

  clear(args: { accountSlot: string; clientNonce: string }): void {
    if (this.load().records.delete(recordKey(args.accountSlot, args.clientNonce))) this.persist();
  }

  clearUnlessAccepted(args: { accountSlot: string; clientNonce: string }): void {
    if (this.load().records.get(recordKey(args.accountSlot, args.clientNonce))?.status !== "accepted") this.clear(args);
  }

  /** Past the cap, one record goes — and the ledger remembers the horizon, so the eviction is not invisible. */
  evictPastCap(): void {
    const loaded = this.load();
    if (loaded.records.size <= MAX_RECORDS) return;
    const key = firstEvictionCandidate(loaded.records);
    if (key == null) return;
    const record = loaded.records.get(key);
    loaded.records.delete(key);
    if (record != null) loaded.gaps = gapsAfterEviction(loaded.gaps, record.acceptedAtMs);
  }

  markerPath(): string | null {
    return this.filePath == null ? null : `${this.filePath}.degraded`;
  }

  private writeRecord(key: string, record: AcceptedSend): void {
    this.load().records.set(key, record);
  }

  /**
   * The ledger as it is on disk, read once and remembered. A damaged file is copied aside before anything else happens, so
   * the bytes that could not be read are still available for whoever investigates.
   */
  private load(): Loaded {
    if (this.loaded != null) return this.loaded;
    const raw = this.readLedgerFile();
    const parsed = readAcceptanceSnapshot(raw);
    let gaps = parsed.gaps;
    if (parsed.damaged && this.filePath != null) {
      this.quarantineCorruptFile();
      gaps = gapsAfterCorruptReset(gaps, this.nowMs());
    }
    const marker = this.readDegradedMarker();
    if (marker != null) {
      gaps = gapsAfterDegradedWindow(gaps, { fromMs: marker, toMs: this.nowMs() });
      this.markerMayExist = true;
    }
    this.loaded = {
      records: new Map(parsed.records.map((record) => [recordKey(record.accountSlot, record.clientNonce), record])),
      gaps,
    };
    // Damage and a recovered marker are both worth writing down now: the next boot should not have to find them again.
    if (parsed.damaged || marker != null) this.persist();
    return this.loaded;
  }

  private readLedgerFile(): string | null {
    if (this.filePath == null) return null;
    try {
      return readFileSync(this.filePath, "utf8");
    } catch {
      // A ledger that is not there is an empty ledger; anything else about it is decided by the parse.
      return null;
    }
  }

  private quarantineCorruptFile(): void {
    if (this.filePath == null) return;
    try {
      copyFileSync(this.filePath, `${this.filePath}.corrupt-${this.nowMs()}`);
    } catch {
      // A copy that cannot be made must not stop the ledger from starting: the reset below still says it happened.
    }
  }

  private readDegradedMarker(): number | null {
    const path = this.markerPath();
    if (path == null) return null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { sinceMs?: unknown };
      return isFiniteNumber(value.sinceMs) ? value.sinceMs : 0;
    } catch {
      return null;
    }
  }

  /**
   * Writes the whole ledger, then renames it into place, so a reader never sees half a file. A write that fails opens a
   * degraded window: the in-memory window is extended, and a marker file says so even if this process never writes again.
   */
  private persist(): void {
    if (this.filePath == null || this.loaded == null) return;
    const now = this.nowMs();
    const gaps = this.degradedSinceMs == null ? this.loaded.gaps : gapsAfterDegradedWindow(this.loaded.gaps, { fromMs: this.degradedSinceMs, toMs: now });
    try {
      this.writeSnapshot(gaps);
    } catch {
      this.markDegraded(now);
      return;
    }
    this.loaded.gaps = gaps;
    this.degradedSinceMs = null;
    this.clearDegradedMarker();
  }

  private writeSnapshot(gaps: LedgerGaps | null): void {
    if (this.filePath == null || this.loaded == null) return;
    const part = `${this.filePath}.part`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(part, JSON.stringify({ version: 1, records: [...this.loaded.records.values()], ...(gaps == null ? {} : { historyGaps: gaps }) }));
    renameSync(part, this.filePath);
  }

  private markDegraded(now: number): void {
    this.degradedSinceMs ??= now;
    const marker = this.markerPath();
    if (this.markerMayExist || marker == null) return;
    try {
      writeFileSync(marker, JSON.stringify({ version: 1, sinceMs: this.degradedSinceMs }));
      this.markerMayExist = true;
    } catch {
      // The window in memory still tells this process's lookups the truth.
    }
  }

  private clearDegradedMarker(): void {
    const marker = this.markerPath();
    if (!this.markerMayExist || marker == null) return;
    try {
      rmSync(marker, { force: true });
      this.markerMayExist = false;
    } catch {
      // A marker that cannot be removed only costs a duplicate window on the next boot.
    }
  }
}
