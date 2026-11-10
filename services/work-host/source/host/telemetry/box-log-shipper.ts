/** The box's own log, carried where the platform can read it.

 * What a box writes down as it runs is read, clamped and shipped in batches, with what was already shipped remembered so
 * a restart does not send it twice and a box that is behind is caught up rather than dropped. */
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../shared/node/atomic-write.ts";
import { findSystemErrno } from "../../shared/system-errno.ts";
import { errorLogTag } from "../../shared/errors/summary.ts";
import {
  SLATE_BOX_BOOT_FAILURE_REASONS,
  SLATE_BOX_BOOT_FAILURE_STAGES,
  SLATE_BOX_BOOT_STAGES,
  SLATE_COOKIE_PERSIST_OUTCOMES,
  SLATE_COOKIE_PERSIST_PHASES,
  SLATE_EGRESS_TUNNEL_OUTCOMES,
  SLATE_EXEC_DAEMON_RESTART_CAUSES,
  SLATE_HOST_BOOT_FETCH_OUTCOMES,
  SLATE_HOST_BOOT_FETCH_REASONS,
  SLATE_PROCESS_CRASH_BINARIES,
  SLATE_PROCESS_CRASH_SIGNALS,
  SLATE_SUPERVISOR_RESTART_CAUSES,
} from "../ports/telemetry.ts";

export const DEFAULT_LOG_DIR = "/tmp",
  BOX_LOG_SHIP_INTERVAL_MS = 2_000,
  BOX_LOG_SHIP_PROGRESS_INTERVAL_MS = 5 * 60_000,
  DEFAULT_MAX_BYTES_PER_READ = 256 * 1024,
  DEFAULT_MAX_LINES_PER_POLL = 1_000,
  DEFAULT_MAX_LAG_BYTES = 16 * 1024 * 1024,
  DEFAULT_MAX_LINE_BYTES = 64 * 1024,
  OFFSETS_FILE_NAME = "slate-log-shipper.offsets.json",
  LOG_SUFFIX = ".log",
  BOX_TELEMETRY_SOURCE = "slate-box-telemetry",
  NEWLINE = 10;
export const DEFAULT_SUBDIR_PATTERN = /^slate-window-/;
export const DEFAULT_EXCLUDED_SOURCE_PREFIXES = [
  "slate-notify-injector",
] as const;
type Settlement = "delivered" | "dropped";
type LogRecord = { kind: "log"; source: string; line: string };
const offsetsSchema = z.record(z.string(), z.number().nonnegative());

const boxInfrastructureEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("boot_stage"),
    stage: z.enum(SLATE_BOX_BOOT_STAGES),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("boot_failure"),
    stage: z.enum(SLATE_BOX_BOOT_FAILURE_STAGES),
    reason: z.enum(SLATE_BOX_BOOT_FAILURE_REASONS),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("egress_tunnel"),
    outcome: z.enum(SLATE_EGRESS_TUNNEL_OUTCOMES),
    attempt: z.number().int().positive(),
    exitStatus: z.number().int().optional(),
    runtimeS: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("host_boot_fetch"),
    outcome: z.enum(SLATE_HOST_BOOT_FETCH_OUTCOMES),
    reason: z.enum(SLATE_HOST_BOOT_FETCH_REASONS),
    durationMs: z.number().int().nonnegative(),
    swapMs: z.number().int().nonnegative().optional(),
    fromVersion: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    toVersion: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("exec_daemon_restart"),
    restartAttempt: z.number().int().positive(),
    runtimeS: z.number().int().nonnegative(),
    cause: z.enum(SLATE_EXEC_DAEMON_RESTART_CAUSES),
    exitStatus: z.number().int(),
  }),
  z.object({
    kind: z.literal("supervisor_restart"),
    restartAttempt: z.number().int().positive(),
    runtimeS: z.number().int().nonnegative(),
    cause: z.enum(SLATE_SUPERVISOR_RESTART_CAUSES),
    exitStatus: z.number().int(),
  }),
  z.object({
    kind: z.literal("cookie_persist"),
    phase: z.enum(SLATE_COOKIE_PERSIST_PHASES),
    outcome: z.enum(SLATE_COOKIE_PERSIST_OUTCOMES),
    seedCookies: z.number().int().nonnegative(),
    injected: z.number().int().nonnegative().optional(),
    missingAfter: z.number().int().nonnegative().optional(),
    attempts: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("process_crash"),
    binary: z.enum(SLATE_PROCESS_CRASH_BINARIES),
    signal: z.enum(SLATE_PROCESS_CRASH_SIGNALS),
    count: z.number().int().positive().max(10_000),
  }),
]);

export type InfrastructureEvent = z.infer<typeof boxInfrastructureEventSchema>;
export type BoxTelemetryRecord =
  LogRecord | { kind: "infrastructure"; event: InfrastructureEvent };
type BoxShipReport =
  | {
      kind: "progress";
      bytesWritten: number;
      bytesDelivered: number;
      pendingWindowCount: number;
      oldestPendingWindowAgeMs: number;
    }
  | {
      kind: "save_failed" | "save_recovered";
      errorClass: string;
      failureCount: number;
    };
interface Clock {
  monotonicNow(): number;
}
interface Polling {
  start(listener: () => Promise<void>): { dispose(): void };
}
interface LogFile {
  path: string;
  source: string;
  size?: number;
}
interface DeliveryWindow {
  candidateEndOffset: number;
  unsettledRecordCount: number;
  didDropRecord: boolean;
  invalidated: boolean;
}
interface SaveFailure {
  errorClass: string;
  failureCount: number;
  reportState:
    | { kind: "in_flight" | "delivered" }
    | { kind: "waiting_for_retry"; retryAtMs: number };
}
export function parseBoxInfrastructureEvent(
  value: unknown,
): InfrastructureEvent | undefined {
  const parsedValue = boxInfrastructureEventSchema.safeParse(value);
  return parsedValue.success ? parsedValue.data : undefined;
}
export class BoxLogShipper {
  readonly offsets = new Map<string, number>();
  readonly pendingDeliveryWindows = new Map<string, DeliveryWindow>();
  readonly pendingWindowStartedAtMs = new Map<string, number>();
  readonly statFailedPaths = new Set<string>();
  private readonly reportBatch: (
    batchRecords: BoxTelemetryRecord[],
    settle: (outcome: Settlement) => void,
  ) => void;
  private readonly reportBoxLogShip: (
    report: BoxShipReport,
    settleRecord?: (outcome: Settlement) => void,
  ) => void;
  private readonly skipPaths: Set<string>;
  private readonly excludedPrefixes: readonly string[];
  private readonly logDirectory: string;
  private readonly windowPattern: RegExp;
  private readonly pollingLoop: Polling;
  private readonly monotonicClock: Clock;
  private readonly readByteBudget: number;
  private readonly lineBudget: number;
  private readonly lagByteLimit: number;
  private readonly lineByteLimit: number;
  private readonly offsetsFilePath: string;
  private readonly offsetWriter: (
    path: string,
    data: Uint8Array,
  ) => Promise<void>;
  private pollSubscription: { dispose(): void } | undefined;
  private currentPoll: Promise<void> | undefined;
  private offsetsHydrated = false;
  private shutDown = false;
  private offsetsUnsaved = false;
  private offsetsVersionNumber = 0;
  private lastProgressAtMs: number | undefined;
  private offsetSaveProblem: SaveFailure | undefined;
  constructor(settings: {
    reportBatch: BoxLogShipper["reportBatch"];
    reportBoxLogShip: BoxLogShipper["reportBoxLogShip"];
    polling: Polling;
    clock: Clock;
    logDir?: string;
    skipPaths?: readonly string[];
    excludeSourcePrefixes?: readonly string[];
    subdirPattern?: RegExp;
    maxBytesPerReadPerFile?: number;
    maxLinesPerPoll?: number;
    maxLagBytes?: number;
    maxLineBytes?: number;
    offsetsPath?: string;
    writeOffsets?: (path: string, data: Uint8Array) => Promise<void>;
  }) {
    this.reportBatch = settings.reportBatch;
    this.reportBoxLogShip = settings.reportBoxLogShip;
    this.logDirectory = settings.logDir ?? DEFAULT_LOG_DIR;
    this.skipPaths = new Set(settings.skipPaths ?? []);
    this.excludedPrefixes =
      settings.excludeSourcePrefixes ?? DEFAULT_EXCLUDED_SOURCE_PREFIXES;
    this.windowPattern = settings.subdirPattern ?? DEFAULT_SUBDIR_PATTERN;
    this.pollingLoop = settings.polling;
    this.monotonicClock = settings.clock;
    this.readByteBudget =
      settings.maxBytesPerReadPerFile ?? DEFAULT_MAX_BYTES_PER_READ;
    this.lineBudget = settings.maxLinesPerPoll ?? DEFAULT_MAX_LINES_PER_POLL;
    this.lagByteLimit = settings.maxLagBytes ?? DEFAULT_MAX_LAG_BYTES;
    this.lineByteLimit = settings.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.offsetsFilePath = settings.offsetsPath ?? join(this.logDirectory, OFFSETS_FILE_NAME);
    this.offsetWriter = settings.writeOffsets ?? writeFileAtomic;
  }
  async start(): Promise<void> {
    await this.loadOffsets();
    this.offsetsHydrated = true;
    let first = true,
      resolveFirst = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    this.pollSubscription = this.pollingLoop.start(async () => {
      try {
        await this.poll();
      } catch (error) {
        console.error("[slate-log-shipper] poll failed:", error);
      } finally {
        if (first) {
          first = false;
          resolveFirst();
        }
      }
    });
    await firstPoll;
  }
  async dispose(): Promise<void> {
    await this.stopPolling();
    await this.saveOffsets();
  }
  async checkpointOffsets(): Promise<void> {
    await this.saveOffsets(true);
  }
  async stopPolling(): Promise<void> {
    this.shutDown = true;
    this.pollSubscription?.dispose();
    this.pollSubscription = undefined;
    await this.currentPoll;
  }
  async poll(): Promise<void> {
    if (this.currentPoll !== undefined || this.shutDown) return;
    const active = this.pollOnce();
    this.currentPoll = active;
    try {
      await active;
    } finally {
      if (this.currentPoll === active) this.currentPoll = undefined;
    }
  }
  async pollOnce(): Promise<void> {
    const scanListing = await this.listLogFiles(),
      sizeSnapshot = await this.snapshotLogFileSizes(scanListing);
    this.reconcileTruncatedOffsets(sizeSnapshot.files);
    let budget = this.lineBudget;
    for (const logFile of sizeSnapshot.files) {
      if (budget <= 0) break;
      try {
        budget -= await this.pumpFile(logFile, budget);
      } catch {}
    }
    if (this.offsetsUnsaved) await this.saveOffsets();
    if (sizeSnapshot.complete) this.maybeReportProgress(sizeSnapshot.files);
    this.maybeRetryOffsetSaveFailure();
  }
  async listLogFiles(): Promise<{ files: LogFile[]; complete: boolean }> {
    const files: LogFile[] = [];
    let complete = true;
    let entries;
    try {
      entries = await readdir(this.logDirectory, { withFileTypes: true });
    } catch {
      return { files, complete: false };
    }
    for (const directoryEntry of entries) {
      if (directoryEntry.isFile() && directoryEntry.name.endsWith(LOG_SUFFIX)) {
        const path = join(this.logDirectory, directoryEntry.name),
          source = toSourceName(directoryEntry.name);
        if (!this.skipPaths.has(path) && !this.isExcludedSource(source))
          files.push({ path, source });
      } else if (directoryEntry.isDirectory() && this.windowPattern.test(directoryEntry.name)) {
        const subdir = join(this.logDirectory, directoryEntry.name);
        let windowEntries;
        try {
          windowEntries = await readdir(subdir, { withFileTypes: true });
        } catch {
          complete = false;
          continue;
        }
        for (const windowEntry of windowEntries) {
          if (!windowEntry.isFile() || !windowEntry.name.endsWith(LOG_SUFFIX)) continue;
          const path = join(subdir, windowEntry.name),
            leafSource = toSourceName(windowEntry.name);
          if (!this.skipPaths.has(path) && !this.isExcludedSource(leafSource))
            files.push({ path, source: `${directoryEntry.name}/${leafSource}` });
        }
      }
    }
    return { files, complete };
  }
  async snapshotLogFileSizes(scanListing: {
    files: LogFile[];
    complete: boolean;
  }): Promise<{ files: Required<LogFile>[]; complete: boolean }> {
    const files: Required<LogFile>[] = [];
    let complete = scanListing.complete;
    for (const logFile of scanListing.files) {
      try {
        const fileStat = await stat(logFile.path);
        this.statFailedPaths.delete(logFile.path);
        if (fileStat.isFile()) files.push({ ...logFile, size: fileStat.size });
      } catch (error) {
        complete = false;
        if (
          findSystemErrno(error) !== "ENOENT" &&
          !this.statFailedPaths.has(logFile.path)
        ) {
          this.statFailedPaths.add(logFile.path);
          console.error(
            `[slate-log-shipper] stat failed for ${logFile.source} (${errorLogTag(error)})`,
          );
        }
      }
    }
    return { files, complete };
  }
  isExcludedSource(leafSource: string): boolean {
    return this.excludedPrefixes.some((prefix) => leafSource.startsWith(prefix));
  }
  reconcileTruncatedOffsets(logFiles: Required<LogFile>[]): void {
    for (const logFile of logFiles) {
      const offset = this.offsets.get(logFile.path);
      if (offset !== undefined && logFile.size < offset) {
        const pending = this.pendingDeliveryWindows.get(logFile.path);
        if (pending === undefined)
          this.pendingWindowStartedAtMs.delete(logFile.path);
        else pending.invalidated = true;
        this.setOffset(logFile.path, 0);
      }
    }
  }
  async pumpFile(logFile: Required<LogFile>, budget: number): Promise<number> {
    const { path, source, size } = logFile;
    if (this.pendingDeliveryWindows.has(path)) return 0;
    let startOffset = this.offsets.get(path) ?? 0;
    if (size <= startOffset) {
      this.pendingWindowStartedAtMs.delete(path);
      return 0;
    }
    let handledCount = 0,
      candidateEndOffset = startOffset;
    const batchRecords: BoxTelemetryRecord[] = [];
    if (size - startOffset > this.lagByteLimit) {
      const jumpTarget = size - this.readByteBudget;
      batchRecords.push({
        kind: "log",
        source,
        line: `[slate-log-shipper] skipped ${jumpTarget - startOffset} bytes (too far behind)`,
      });
      handledCount += 1;
      startOffset = jumpTarget;
      candidateEndOffset = jumpTarget;
    }
    const length = Math.min(size - startOffset, this.readByteBudget),
      byteBuffer = Buffer.alloc(length),
      openHandle = await open(path, "r");
    let bytesRead = 0;
    try {
      ({ bytesRead } = await openHandle.read(byteBuffer, 0, length, startOffset));
    } finally {
      await openHandle.close();
    }
    if (bytesRead <= 0) {
      this.reportDeliveryWindow(path, candidateEndOffset, batchRecords);
      return handledCount;
    }
    const inputChunk = byteBuffer.subarray(0, bytesRead),
      lastNewline = inputChunk.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      if (startOffset + bytesRead < size) {
        const record = this.toTelemetryRecord({
          source,
          line: inputChunk.subarray(0, this.lineByteLimit).toString("utf8"),
        });
        if (record !== undefined) batchRecords.push(record);
        candidateEndOffset = startOffset + bytesRead;
        handledCount += 1;
      }
      this.reportDeliveryWindow(path, candidateEndOffset, batchRecords);
      return handledCount;
    }
    let cursorPosition = 0;
    while (handledCount < budget) {
      const newlinePosition = inputChunk.indexOf(NEWLINE, cursorPosition);
      if (newlinePosition === -1 || newlinePosition > lastNewline) break;
      let line = inputChunk.subarray(cursorPosition, newlinePosition).toString("utf8");
      cursorPosition = newlinePosition + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        const record = this.toTelemetryRecord({ source, line });
        if (record !== undefined) batchRecords.push(record);
        handledCount += 1;
      }
    }
    candidateEndOffset = startOffset + cursorPosition;
    this.reportDeliveryWindow(path, candidateEndOffset, batchRecords);
    return handledCount;
  }
  toTelemetryRecord(directoryEntry: {
    source: string;
    line: string;
  }): BoxTelemetryRecord | undefined {
    if (directoryEntry.source !== BOX_TELEMETRY_SOURCE) return { kind: "log", ...directoryEntry };
    let value: unknown;
    try {
      value = JSON.parse(directoryEntry.line);
    } catch {
      return undefined;
    }
    const event = parseBoxInfrastructureEvent(value);
    return event === undefined ? undefined : { kind: "infrastructure", event };
  }
  reportDeliveryWindow(
    path: string,
    candidateEndOffset: number,
    batchRecords: BoxTelemetryRecord[],
  ): void {
    if (batchRecords.length === 0) {
      this.setOffset(path, candidateEndOffset);
      return;
    }
    const deliveryWindow: DeliveryWindow = {
      candidateEndOffset,
      unsettledRecordCount: batchRecords.length,
      didDropRecord: false,
      invalidated: false,
    };
    if (!this.pendingWindowStartedAtMs.has(path))
      this.pendingWindowStartedAtMs.set(path, this.monotonicClock.monotonicNow());
    this.pendingDeliveryWindows.set(path, deliveryWindow);
    this.reportBatch(batchRecords, (outcome) =>
      this.settleDeliveryWindow(path, deliveryWindow, outcome),
    );
  }
  settleDeliveryWindow(
    path: string,
    deliveryWindow: DeliveryWindow,
    outcome: Settlement,
  ): void {
    deliveryWindow.unsettledRecordCount -= 1;
    if (outcome === "dropped") deliveryWindow.didDropRecord = true;
    if (deliveryWindow.unsettledRecordCount > 0) return;
    this.pendingDeliveryWindows.delete(path);
    if (!deliveryWindow.didDropRecord && !deliveryWindow.invalidated)
      this.setOffset(path, deliveryWindow.candidateEndOffset);
  }
  setOffset(path: string, offset: number): void {
    const previousOffset = this.offsets.get(path);
    if (previousOffset === offset) return;
    this.offsets.set(path, offset);
    if (offset > (previousOffset ?? 0)) this.pendingWindowStartedAtMs.delete(path);
    this.offsetsUnsaved = true;
    this.offsetsVersionNumber += 1;
  }
  async loadOffsets(): Promise<void> {
    const rawBody = await readFile(this.offsetsFilePath, "utf8").catch(
      (error: unknown) => {
        if (findSystemErrno(error) !== "ENOENT")
          console.error(
            `[slate-log-shipper] offsets read failed (${errorLogTag(error)})`,
          );
        return null;
      },
    );
    if (rawBody === null) return;
    let parsedValue;
    try {
      parsedValue = offsetsSchema.safeParse(JSON.parse(rawBody));
    } catch {
      return;
    }
    if (!parsedValue.success) return;
    for (const [path, offset] of Object.entries(parsedValue.data))
      this.offsets.set(path, offset);
  }
  async saveOffsets(force = false): Promise<void> {
    if (!this.offsetsHydrated || (!force && !this.offsetsUnsaved)) return;
    const saveRevision = this.offsetsVersionNumber,
      record: Record<string, number> = {};
    for (const [path, offset] of this.offsets) record[path] = offset;
    try {
      await this.offsetWriter(
        this.offsetsFilePath,
        Buffer.from(JSON.stringify(record)),
      );
      if (this.offsetsVersionNumber === saveRevision) {
        this.offsetsUnsaved = false;
        this.noteOffsetSaveSucceeded();
      }
    } catch (error) {
      this.offsetsUnsaved = true;
      this.noteOffsetSaveFailed(error);
    }
  }
  maybeReportProgress(logFiles: Required<LogFile>[]): void {
    const monoNow = this.monotonicClock.monotonicNow();
    if (
      this.lastProgressAtMs !== undefined &&
      monoNow - this.lastProgressAtMs < BOX_LOG_SHIP_PROGRESS_INTERVAL_MS
    )
      return;
    let bytesWritten = 0,
      bytesDelivered = 0;
    for (const logFile of logFiles) {
      bytesWritten = saturatingAdd(bytesWritten, logFile.size);
      bytesDelivered = saturatingAdd(
        bytesDelivered,
        Math.min(logFile.size, this.offsets.get(logFile.path) ?? 0),
      );
    }
    let oldestPendingWindowAgeMs = 0;
    for (const windowStartMs of this.pendingWindowStartedAtMs.values())
      oldestPendingWindowAgeMs = Math.max(
        oldestPendingWindowAgeMs,
        toNonnegativeSafeInteger(monoNow - windowStartMs),
      );
    this.lastProgressAtMs = monoNow;
    this.reportBoxLogShip({
      kind: "progress",
      bytesWritten,
      bytesDelivered,
      pendingWindowCount: toNonnegativeSafeInteger(
        this.pendingWindowStartedAtMs.size,
      ),
      oldestPendingWindowAgeMs,
    });
  }
  maybeRetryOffsetSaveFailure(): void {
    const failure = this.offsetSaveProblem;
    if (
      failure?.reportState.kind === "waiting_for_retry" &&
      this.monotonicClock.monotonicNow() >= failure.reportState.retryAtMs
    )
      this.reportOffsetSaveFailure(failure);
  }
  noteOffsetSaveFailed(error: unknown): void {
    const saveErrorKind = classifyOffsetSaveError(error),
      failure = this.offsetSaveProblem;
    if (failure !== undefined) {
      failure.errorClass = saveErrorKind;
      failure.failureCount = saturatingAdd(failure.failureCount, 1);
      return;
    }
    const next: SaveFailure = {
      errorClass: saveErrorKind,
      failureCount: 1,
      reportState: { kind: "in_flight" },
    };
    this.offsetSaveProblem = next;
    this.reportOffsetSaveFailure(next);
  }
  reportOffsetSaveFailure(failure: SaveFailure): void {
    failure.reportState = { kind: "in_flight" };
    this.reportBoxLogShip(
      {
        kind: "save_failed",
        errorClass: failure.errorClass,
        failureCount: failure.failureCount,
      },
      (outcome) => {
        if (
          this.offsetSaveProblem !== failure ||
          failure.reportState.kind !== "in_flight"
        )
          return;
        failure.reportState =
          outcome === "delivered"
            ? { kind: "delivered" }
            : {
                kind: "waiting_for_retry",
                retryAtMs:
                  this.monotonicClock.monotonicNow() + BOX_LOG_SHIP_PROGRESS_INTERVAL_MS,
              };
      },
    );
  }
  noteOffsetSaveSucceeded(): void {
    const failure = this.offsetSaveProblem;
    if (failure === undefined) return;
    this.offsetSaveProblem = undefined;
    this.reportBoxLogShip({
      kind: "save_recovered",
      errorClass: failure.errorClass,
      failureCount: failure.failureCount,
    });
  }
}
export function isBoxLogShippingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.SLATE_HOST_IN_BOX !== "1") return false;
  const disabledFlag = env.SLATE_BOX_LOG_SHIP_DISABLED?.trim().toLowerCase();
  return !(disabledFlag === "1" || disabledFlag === "true" || disabledFlag === "yes");
}
export function toSourceName(leafFileName: string): string {
  return leafFileName.endsWith(LOG_SUFFIX)
    ? leafFileName.slice(0, -LOG_SUFFIX.length)
    : leafFileName;
}
export function classifyOffsetSaveError(error: unknown): string {
  switch (findSystemErrno(error)) {
    case "ENOSPC":
    case "EDQUOT":
      return "no_space";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "EROFS":
      return "read_only";
    case "ENOENT":
      return "missing_parent";
    case undefined:
      return "unknown";
    default:
      return "io";
  }
}
export function saturatingAdd(total: number, value: number): number {
  const clamped = toNonnegativeSafeInteger(value);
  return total >= Number.MAX_SAFE_INTEGER - clamped
    ? Number.MAX_SAFE_INTEGER
    : total + clamped;
}
export function toNonnegativeSafeInteger(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}
