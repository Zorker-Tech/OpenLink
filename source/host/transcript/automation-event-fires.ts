/** Waking an automation because something happened.

 * Events that arrive for the same automation are gathered for a moment and delivered together, with what was dropped
 * reported rather than silently lost, and an automation that is no longer there is not woken at all. */
import {
  MAX_EVENTS_IN_AUTOMATION_WAKE,
  type AutomationRecord,
} from "../automations/automation.ts";
import { errorMessage } from "../../shared/errors/summary.ts";
import type { TranscriptManagerLike } from "./transcript-hub.ts";

export const EVENT_FIRE_DEBOUNCE_MS = 750;
export const MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION = 500;
export const MAX_REPORTED_DROPPED_FIRES = 256;

type FireOutcome = "ok" | "error" | "interrupted" | undefined;
interface FireItem {
  event: Record<string, unknown>;
  runUuid?: string;
  resolve(resultOutcome: FireOutcome): void;
}
interface FireBatch {
  agentId: string;
  automation: AutomationRecord;
  items: FireItem[];
  debounce: AbortController | null;
  /** Compatibility handle used by manager teardown while abortController is armed. */
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  flushImmediately: boolean;
}
export interface DroppedFire {
  agentId: string;
  trigger: "schedule" | "manual" | "event";
  reason: string;
  scheduledForMs?: number;
  runUuid?: string;
}

export class AutomationEventFires {
  readonly pendingEventFireBatches = new Map<string, FireBatch>();
  readonly reportedDroppedFireUuids = new Set<string>();

  constructor(readonly tm: TranscriptManagerLike) {}

  enqueueEventAutomationFire(request: {
    agentId: string;
    automation: AutomationRecord;
    event: Record<string, unknown>;
    runUuid?: string;
  }): Promise<FireOutcome> {
    if (!this.tm.execution.canExecute || this.tm.disposed)
      return Promise.resolve(undefined);
    const batchKey = `${request.agentId}:${request.automation.id}`;
    return new Promise((settle) => {
      let pendingBatch = this.pendingEventFireBatches.get(batchKey);
      if (pendingBatch == null) {
        pendingBatch = {
          agentId: request.agentId,
          automation: request.automation,
          items: [],
          debounce: null,
          timer: null,
          flushing: false,
          flushImmediately: false,
        };
        this.pendingEventFireBatches.set(batchKey, pendingBatch);
      }
      pendingBatch.automation = request.automation;
      pendingBatch.items.push({
        event: request.event,
        ...(request.runUuid === undefined ? {} : { runUuid: request.runUuid }),
        resolve: settle,
      });
      this.shedOverflowingEventFires(batchKey);
      this.scheduleEventBatchFlush(batchKey);
    });
  }

  shedOverflowingEventFires(batchKey: string): void {
    const pendingBatch = this.pendingEventFireBatches.get(batchKey);
    if (pendingBatch == null) return;
    const overflowCount = pendingBatch.items.length - MAX_QUEUED_EVENT_FIRES_PER_AUTOMATION;
    if (overflowCount <= 0) return;
    for (const queuedItem of pendingBatch.items.splice(0, overflowCount)) {
      this.reportFireDropped({
        agentId: pendingBatch.agentId,
        trigger: "event",
        reason: "event_batch_overflow",
        ...(queuedItem.runUuid === undefined ? {} : { runUuid: queuedItem.runUuid }),
      });
      queuedItem.resolve("error");
    }
  }

  scheduleEventBatchFlush(batchKey: string): void {
    const pendingBatch = this.pendingEventFireBatches.get(batchKey);
    if (
      pendingBatch == null ||
      pendingBatch.items.length === 0 ||
      pendingBatch.flushing ||
      pendingBatch.debounce != null
    )
      return;
    const abortController = new AbortController();
    pendingBatch.debounce = abortController;
    const delayMs = pendingBatch.flushImmediately ? 0 : EVENT_FIRE_DEBOUNCE_MS;
    pendingBatch.flushImmediately = false;
    pendingBatch.timer = setTimeout(() => {
      pendingBatch.timer = null;
      pendingBatch.debounce = null;
      if (!abortController.signal.aborted) void this.flushEventBatch(batchKey);
    }, delayMs);
  }

  async flushEventBatch(batchKey: string): Promise<void> {
    const pendingBatch = this.pendingEventFireBatches.get(batchKey);
    if (
      pendingBatch == null ||
      pendingBatch.items.length === 0 ||
      pendingBatch.flushing ||
      this.tm.disposed
    )
      return;
    pendingBatch.flushing = true;
    const queuedItems = pendingBatch.items.splice(0, MAX_EVENTS_IN_AUTOMATION_WAKE);
    const runIdentifiers = queuedItems.flatMap((queuedItem) =>
      queuedItem.runUuid === undefined ? [] : [queuedItem.runUuid],
    );
    let resultOutcome: FireOutcome;
    try {
      resultOutcome = (await this.tm.automationRuntime.fireAutomation({
        agentId: pendingBatch.agentId,
        automation: pendingBatch.automation,
        trigger: "event",
        events: queuedItems.map((queuedItem) => queuedItem.event),
        ...(runIdentifiers[0] === undefined ? {} : { runUuid: runIdentifiers[0] }),
        coalescedRunUuids: runIdentifiers.slice(1),
      })) as FireOutcome;
    } catch (cause) {
      console.error(
        `[slate:automation] event wake dispatch failed for "${pendingBatch.automation.name}" (${pendingBatch.automation.id}): ${errorMessage(cause)}`,
      );
    } finally {
      for (const queuedItem of queuedItems) queuedItem.resolve(resultOutcome);
      pendingBatch.flushing = false;
      if (pendingBatch.items.length > 0) {
        pendingBatch.flushImmediately = true;
        this.scheduleEventBatchFlush(batchKey);
      } else {
        this.pendingEventFireBatches.delete(batchKey);
      }
    }
  }

  reportFireDropped(request: DroppedFire): void {
    if (request.runUuid !== undefined) {
      if (this.reportedDroppedFireUuids.has(request.runUuid)) return;
      this.reportedDroppedFireUuids.add(request.runUuid);
      while (this.reportedDroppedFireUuids.size > MAX_REPORTED_DROPPED_FIRES) {
        const oldestReported = this.reportedDroppedFireUuids.values().next().value as
          string | undefined;
        if (oldestReported === undefined) break;
        this.reportedDroppedFireUuids.delete(oldestReported);
      }
    }
    this.tm.telemetry.reportAutomationFireDropped({
      conversationId: request.agentId,
      trigger: request.trigger,
      reason: request.reason,
      ...(request.scheduledForMs == null
        ? {}
        : {
            scheduledForMs: request.scheduledForMs,
            latenessMs: Math.max(0, Date.now() - request.scheduledForMs),
          }),
    });
  }
}
