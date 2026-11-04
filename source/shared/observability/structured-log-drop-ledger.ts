import { TELEMETRY_DROP_REASONS, type TelemetryDropReason } from "./telemetry-events.ts";
import type { DropCounters, StructuredLogCheckpoint } from "./structured-log-transport-contracts.ts";
import { cloneDropCounters, createDropCounterId, emptyDropCounters } from "./structured-log-transport-values.ts";

export interface PendingDropReport {
  readonly reason: TelemetryDropReason;
  readonly through: number;
}

export class StructuredLogDropLedger {
  private counterId: string;
  private counters: DropCounters;

  constructor(restored?: StructuredLogCheckpoint) {
    this.counterId = restored?.counterId ?? createDropCounterId();
    this.counters = restored === undefined ? emptyDropCounters() : cloneDropCounters(restored.counters);
  }

  id(): string {
    return this.counterId;
  }

  snapshot(): DropCounters {
    return cloneDropCounters(this.counters);
  }

  record(reason: TelemetryDropReason, count: number): void {
    if (count <= 0) return;
    const current = this.counters[reason];
    current.observed += Math.min(count, Number.MAX_SAFE_INTEGER - current.observed);
  }

  hasPending(): boolean {
    return TELEMETRY_DROP_REASONS.some((reason) => {
      const counter = this.counters[reason];
      return counter.observed > counter.acknowledgedThrough;
    });
  }

  pendingReports(): PendingDropReport[] {
    return TELEMETRY_DROP_REASONS.flatMap((reason) => {
      const counter = this.counters[reason];
      return counter.observed > counter.acknowledgedThrough
        ? [{ reason, through: counter.observed }]
        : [];
    });
  }

  acknowledge(reports: readonly PendingDropReport[]): void {
    for (const { reason, through } of reports) {
      const counter = this.counters[reason];
      counter.acknowledgedThrough = Math.max(counter.acknowledgedThrough, through);
    }
  }

  reset(): void {
    this.counterId = createDropCounterId();
    this.counters = emptyDropCounters();
  }
}
