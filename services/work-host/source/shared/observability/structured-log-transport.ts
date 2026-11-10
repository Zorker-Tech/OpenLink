/**
 * Ships structured host logs, journals delivery failures and coordinates retry, identity and shutdown lifetimes.
 */

import { SlateError, slateErrorTags } from "../errors/registry.ts";
import { LogShipSchedule, type LogShipResult } from "./log-ship-cadence.ts";
import {
  TELEMETRY_DROPPED_EVENT,
  TELEMETRY_DROP_UNIT_BY_REASON,
  TELEMETRY_SHIP_TIMEOUT_EVENT,
  type TelemetryDropReason,
} from "./telemetry-events.ts";
import { StructuredLogBuffer } from "./structured-log-buffer.ts";
import { StructuredLogDropLedger } from "./structured-log-drop-ledger.ts";
import type {
  BufferedStructuredLog,
  StructuredLogCheckpoint,
  StructuredLogClient,
  StructuredLogEntry,
  StructuredLogLevel,
  StructuredLogTransportOptions,
} from "./structured-log-transport-contracts.ts";
import {
  STRUCTURED_LOG_REPLAY_MAX_AGE_MS,
  cleanStructuredLogMetadata,
  isDeadlineExpiry,
  isValidLogShipReceipt,
  toClientLogLevel,
} from "./structured-log-transport-values.ts";

export {
  DEADLINE_EXPIRY_CODE,
  MAX_BUFFER_SIZE,
  STRUCTURED_LOG_REPLAY_MAX_AGE_MS,
  STRUCTURED_LOG_SUBMIT_DEADLINE_MS,
  cleanStructuredLogMetadata,
  cloneDropCounters,
  createDropCounterId,
  emptyDropCounters,
  isDeadlineExpiry,
  isValidLogShipReceipt,
  toClientLogLevel,
  truncateStructuredLogValue,
} from "./structured-log-transport-values.ts";
export { ClientLogLevel } from "./structured-log-transport-contracts.ts";
export type {
  BufferedStructuredLog,
  DropCounter,
  DropCounters,
  StructuredLogCheckpoint,
  StructuredLogClient,
  StructuredLogEntry,
  StructuredLogLevel,
  StructuredLogTransportOptions,
} from "./structured-log-transport-contracts.ts";

export class StructuredLogTransport {
  private readonly platformTags: Record<string, string>;
  private readonly shipSchedule = new LogShipSchedule();
  private readonly dropLedger: StructuredLogDropLedger;
  private readonly logBuffer: StructuredLogBuffer;
  private client: StructuredLogClient | undefined;
  private pollingHandle: { dispose(): void } | undefined;
  private identityHoldHandle: { dispose(): void } | undefined;
  private identityTags: Record<string, string> = {};
  private disposed = false;
  private deliveryGeneration = 0;
  private readonly requestAbortControllers = new Set<AbortController>();
  private flushHeldForIdentity: boolean;
  private flushTickListener: (() => void) | undefined;
  private flushSettledListener: (() => void | Promise<void>) | undefined;
  private flushChain: Promise<boolean> = Promise.resolve(false);
  private eagerFlushQueued = false;
  private eagerDrainRequested = false;
  private submitTimeoutStreakActive = false;

  constructor(private readonly options: StructuredLogTransportOptions) {
    this.platformTags = cleanStructuredLogMetadata(options.platformTags);
    this.dropLedger = new StructuredLogDropLedger(options.initialCheckpoint);
    this.logBuffer = new StructuredLogBuffer(options.initialCheckpoint?.records);
    this.flushHeldForIdentity = options.holdForIdentity === true;

    if (this.flushHeldForIdentity) {
      if (options.identityHoldExpiry === undefined) {
        throw new TypeError("identityHoldExpiry is required when holdForIdentity is true");
      }
      this.identityHoldHandle = options.identityHoldExpiry.arm(
        "structured-log-host-identity",
        () => this.releaseIdentityHold(),
      );
    }

    this.ensurePolling();
  }

  setIdentityTags(tags: Readonly<Record<string, string | undefined>>): void {
    this.identityTags = cleanStructuredLogMetadata(tags);
    this.releaseIdentityHold();
  }

  setFlushTickListener(listener?: () => void): void {
    this.flushTickListener = listener;
    if (listener !== undefined) this.ensurePolling();
    else if (this.options.disabled) {
      this.pollingHandle?.dispose();
      this.pollingHandle = undefined;
    }
  }

  setFlushSettledListener(listener?: () => void | Promise<void>): void {
    this.flushSettledListener = listener;
  }

  enqueue(
    level: StructuredLogLevel,
    message: string,
    metadata: Readonly<Record<string, string | undefined>>,
    onSettled?: BufferedStructuredLog["onSettled"],
  ): void {
    this.enqueueAt(level, message, metadata, Date.now(), onSettled);
  }

  enqueueAt(
    level: StructuredLogLevel,
    message: string,
    metadata: Readonly<Record<string, string | undefined>>,
    timestamp: number,
    onSettled?: BufferedStructuredLog["onSettled"],
  ): void {
    if (this.options.disabled || this.disposed) {
      onSettled?.("dropped");
      return;
    }

    const record: BufferedStructuredLog = {
      level,
      message,
      metadata: { ...this.platformTags, ...cleanStructuredLogMetadata(metadata) },
      timestamp,
      ...(onSettled === undefined ? {} : { onSettled }),
    };
    this.handleOverflow(this.logBuffer.enqueue(record));

    if (level === "error") this.shipSchedule.shipNext();
    if (this.logBuffer.queuedCount() >= 128) {
      this.eagerDrainRequested = true;
      this.queueEagerDrain();
    }
  }

  async shipConfirmed(
    level: StructuredLogLevel,
    message: string,
    metadata: Readonly<Record<string, string | undefined>>,
  ): Promise<boolean> {
    if (this.options.disabled) return true;
    if (this.disposed) return false;

    const generation = this.deliveryGeneration;
    const entry = this.buildLogEntry(
      level,
      message,
      { ...this.platformTags, ...cleanStructuredLogMetadata(metadata) },
      Date.now(),
    );
    const result = await this.shipLogs([entry]);
    if (generation === this.deliveryGeneration) this.recordSourceResult(result);
    return result.delivered;
  }

  capturePending(): BufferedStructuredLog[] {
    return this.logBuffer.pendingRows();
  }

  captureCheckpoint(): StructuredLogCheckpoint {
    return {
      counterId: this.dropLedger.id(),
      counters: this.dropLedger.snapshot(),
      records: this.capturePending(),
    };
  }

  recordDropped(reason: TelemetryDropReason, count: number): void {
    this.dropLedger.record(reason, count);
  }

  clearPending(): Promise<void> {
    this.deliveryGeneration += 1;
    for (const request of this.requestAbortControllers) request.abort();
    this.requestAbortControllers.clear();
    this.settle(this.logBuffer.clear(), "dropped");
    this.eagerDrainRequested = false;
    this.client = undefined;
    this.dropLedger.reset();
    this.flushChain = this.flushChain.then(() => false, () => false);
    return this.flushChain.then(() => undefined);
  }

  async flushNow(): Promise<boolean> {
    if (this.disposed) return this.logBuffer.pendingCount() === 0 && !this.dropLedger.hasPending();
    return this.drain();
  }

  async dispose(): Promise<boolean> {
    if (this.disposed) return this.logBuffer.pendingCount() === 0 && !this.dropLedger.hasPending();
    this.disposed = true;
    this.pollingHandle?.dispose();
    this.pollingHandle = undefined;
    this.flushHeldForIdentity = false;
    this.identityHoldHandle?.dispose();
    this.identityHoldHandle = undefined;

    const drained = await this.drain();
    if (!drained && this.options.retainUndeliveredOnDispose !== true) {
      this.settle(this.logBuffer.clear(), "dropped");
    }
    return drained;
  }

  private async drain(): Promise<boolean> {
    while (this.logBuffer.pendingCount() > 0 || this.dropLedger.hasPending()) {
      const progressed = await this.flush();
      if (!progressed && (this.logBuffer.pendingCount() > 0 || this.dropLedger.hasPending())) return false;
    }
    return true;
  }

  private ensurePolling(): void {
    if (
      this.disposed
      || this.pollingHandle !== undefined
      || (this.options.disabled && this.flushTickListener === undefined)
    ) return;

    this.pollingHandle = this.options.polling.start(async () => {
      try {
        this.flushTickListener?.();
      } catch {
        // A consumer callback does not get to stop the transport's scheduled flush.
      }
      try {
        await this.flushIfDue(false);
      } catch (error) {
        console.error("[structured-log-transport] flush tick failed:", error);
      }
    });
  }

  private releaseIdentityHold(): void {
    if (!this.flushHeldForIdentity) return;
    this.flushHeldForIdentity = false;
    this.identityHoldHandle?.dispose();
    this.identityHoldHandle = undefined;
    void this.flushIfDue(true);
  }

  private async flushIfDue(eager: boolean): Promise<void> {
    if ((this.logBuffer.queuedCount() === 0 && !this.dropLedger.hasPending()) || !this.shipSchedule.isDue(eager)) {
      return;
    }
    await this.flush();
    this.queueEagerDrain();
  }

  private queueEagerDrain(): void {
    if (
      this.disposed
      || this.eagerFlushQueued
      || !this.eagerDrainRequested
      || this.flushHeldForIdentity
      || !this.logBuffer.hasQueuedRows()
      || !this.shipSchedule.isDue(true)
    ) return;

    this.eagerFlushQueued = true;
    void this.drainEager().finally(() => {
      this.eagerFlushQueued = false;
      this.queueEagerDrain();
    });
  }

  private async drainEager(): Promise<void> {
    while (
      !this.disposed
      && this.eagerDrainRequested
      && !this.flushHeldForIdentity
      && this.logBuffer.hasQueuedRows()
      && this.shipSchedule.isDue(true)
    ) {
      await this.flush();
    }
    if (!this.logBuffer.hasQueuedRows()) this.eagerDrainRequested = false;
  }

  private flush(): Promise<boolean> {
    this.flushChain = this.flushChain.then(() => this.flushOnce(), () => this.flushOnce());
    return this.flushChain;
  }

  private async finishFlush(progressed: boolean): Promise<boolean> {
    await this.flushSettledListener?.();
    return progressed;
  }

  private async flushOnce(): Promise<boolean> {
    if (this.flushHeldForIdentity) return false;
    const generation = this.deliveryGeneration;

    if (!this.logBuffer.hasQueuedRows()) {
      const attempt = await this.reportPendingDrops(generation);
      if (generation !== this.deliveryGeneration) return this.finishFlush(true);
      if (attempt !== undefined) this.shipSchedule.record(attempt.result);
      return this.finishFlush(attempt?.acknowledged ?? false);
    }

    this.expireBufferedLogs();
    if (!this.logBuffer.hasQueuedRows()) {
      const attempt = await this.reportPendingDrops(generation);
      if (generation !== this.deliveryGeneration) return this.finishFlush(true);
      if (attempt !== undefined) this.shipSchedule.record(attempt.result);
      return this.finishFlush(attempt?.acknowledged ?? false);
    }

    const batch = this.logBuffer.takeBatch();
    const entries = batch.map((record) =>
      this.buildLogEntry(record.level, record.message, record.metadata, record.timestamp),
    );
    const result = await this.shipLogs(entries);
    if (generation !== this.deliveryGeneration) {
      this.logBuffer.discardSendingBatch();
      return this.finishFlush(true);
    }

    if (!result.delivered) {
      const evicted = this.logBuffer.restoreSendingBatch();
      this.recordSourceResult(result);
      this.handleOverflow(evicted);
      this.shipSchedule.record(result);
      return this.finishFlush(false);
    }

    this.logBuffer.settleSendingBatch("delivered");
    this.recordSourceResult(result);
    this.shipSchedule.record(result);
    await this.reportPendingDrops(generation);
    return this.finishFlush(true);
  }

  private expireBufferedLogs(): void {
    const expiredCount = this.logBuffer.expireQueued(Date.now(), STRUCTURED_LOG_REPLAY_MAX_AGE_MS);
    this.dropLedger.record("replay_expired", expiredCount);
  }

  private recordSourceResult(result: LogShipResult): void {
    if (!result.delivered) this.dropLedger.record("ship_failed", 1);
    else this.dropLedger.record("backend_dropped", result.receipt?.logsDropped ?? 0);
  }

  private async reportPendingDrops(
    generation: number,
  ): Promise<{ readonly result: LogShipResult; readonly acknowledged: boolean } | undefined> {
    const reports = this.dropLedger.pendingReports();
    if (reports.length === 0) return undefined;

    const timestamp = Date.now();
    const entries = reports.map(({ reason, through }) =>
      this.buildLogEntry("warn", TELEMETRY_DROPPED_EVENT, {
        ...this.platformTags,
        reason,
        unit: TELEMETRY_DROP_UNIT_BY_REASON[reason],
        count: String(through),
        counter_id: this.dropLedger.id(),
      }, timestamp),
    );
    const result = await this.shipLogs(entries);
    if (generation !== this.deliveryGeneration) return { result, acknowledged: true };
    if (
      !result.delivered
      || result.receipt?.logsProcessed !== entries.length
      || result.receipt.logsDropped !== 0
    ) return { result, acknowledged: false };

    this.dropLedger.acknowledge(reports);
    return { result, acknowledged: true };
  }

  private handleOverflow(evicted: readonly BufferedStructuredLog[]): void {
    if (evicted.length === 0) return;
    this.dropLedger.record("overflow_evicted", evicted.length);
    this.settle(evicted, "dropped");
  }

  private settle(records: readonly BufferedStructuredLog[], result: "delivered" | "dropped"): void {
    for (const record of records) record.onSettled?.(result);
  }

  private buildLogEntry(
    level: StructuredLogLevel,
    message: string,
    metadata: Readonly<Record<string, string>>,
    timestamp: number,
  ): StructuredLogEntry {
    return {
      level: toClientLogLevel(level),
      message,
      metadata: { ...this.identityTags, ...metadata },
      timestamp: BigInt(timestamp),
      key: this.options.key,
    };
  }

  private reportSubmitTimeout(error: unknown, batchEntries: number): void {
    if (!isDeadlineExpiry(error)) {
      this.submitTimeoutStreakActive = false;
      return;
    }
    if (this.submitTimeoutStreakActive) return;
    this.submitTimeoutStreakActive = true;
    this.enqueue("warn", TELEMETRY_SHIP_TIMEOUT_EVENT, slateErrorTags(SlateError.logShipTimeout({ batchEntries })));
  }

  private async shipLogs(logs: readonly StructuredLogEntry[]): Promise<LogShipResult> {
    if (logs.length === 0) return { delivered: true, receipt: { logsProcessed: 0, logsDropped: 0 } };

    const requestAbort = new AbortController();
    this.requestAbortControllers.add(requestAbort);
    const client = this.client ?? (this.client = this.options.createClient());

    try {
      const response = await this.options.submitDeadline.run((signal) =>
        client.submitLogs({ logs }, { signal: AbortSignal.any([signal, requestAbort.signal]) }),
      );
      this.submitTimeoutStreakActive = false;
      return {
        delivered: true,
        ...(isValidLogShipReceipt(response, logs.length)
          ? { receipt: { logsProcessed: response.logsProcessed, logsDropped: response.logsDropped } }
          : {}),
      };
    } catch (error) {
      if (this.client === client) this.client = undefined;
      this.reportSubmitTimeout(error, logs.length);
      return { delivered: false, error };
    } finally {
      this.requestAbortControllers.delete(requestAbort);
    }
  }
}
