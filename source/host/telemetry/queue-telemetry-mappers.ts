/**
 * The send queue, as the telemetry backend sees it.
 *
 * What was accepted, dequeued, dispatched and dropped is reported under its own event names, with the wait a message
 * spent in the queue turned into the numbers the backend takes.
 */
type QueueFields = Record<string, string | number | boolean | null | undefined>;
type QueueEvent = { readonly level: "info" | "warn"; readonly event: string; readonly metadata: Record<string, unknown> };

export const SEND_DISPATCH_EVENT = "slate.send_dispatch";
export const QUEUE_ACCEPTED_EVENT = "slate.queue.accepted";
export const QUEUE_DEQUEUED_EVENT = "slate.queue.dequeued";
export const QUEUE_WATCHDOG_EVENT = "slate.queue.watchdog";
export const ACK_OBLIGATION_EVENT = "slate.ack.obligation";
export const PENDING_WAKE_EVENT = "slate.pending_wake";

function text(value: unknown): string {
  return String(value);
}

function roundedMilliseconds(value: unknown): string {
  return String(Math.round(value as number));
}

function maybeText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function maybeRoundedMilliseconds(value: unknown): string | undefined {
  return value === undefined ? undefined : roundedMilliseconds(value);
}

function nullableText(value: unknown): string | undefined {
  return value == null ? undefined : text(value);
}

function event(level: QueueEvent["level"], name: string, metadata: Record<string, unknown>): QueueEvent {
  return { level, event: name, metadata };
}

export function sendDispatchTelemetry(record: QueueFields): QueueEvent {
  return event("info", SEND_DISPATCH_EVENT, {
    conversation_id: record.conversationId,
    send_dispatch_ms: maybeRoundedMilliseconds(record.dispatchMs),
    send_dispatch_host_ms: roundedMilliseconds(record.hostDispatchMs),
    skew: text(record.skew),
    skew_reason: record.skewReason,
    skew_bucket: record.skewBucket,
    is_fork: text(record.isFork),
    model_id: record.modelId,
    trace_id: record.traceId,
    span_id: record.spanId,
  });
}

export function queueAcceptedTelemetry(record: QueueFields): QueueEvent {
  return event("info", QUEUE_ACCEPTED_EVENT, {
    conversation_id: record.conversationId,
    lane: record.lane,
    source: record.source,
    position: text(record.position),
    depth_user: text(record.depthUser),
    depth_agent: text(record.depthAgent),
    depth_background: text(record.depthBackground),
    has_active: text(record.hasActive),
  });
}

export function queueDequeuedTelemetry(record: QueueFields): QueueEvent {
  return event("info", QUEUE_DEQUEUED_EVENT, {
    conversation_id: record.conversationId,
    lane: record.lane,
    source: record.source,
    queue_wait_ms: roundedMilliseconds(record.queueWaitMs),
    accepted_to_run_ms: maybeRoundedMilliseconds(record.acceptedToRunMs),
    jumped_background: text(record.jumpedBackground),
    depth_user: text(record.depthUser),
    depth_agent: text(record.depthAgent),
    depth_background: text(record.depthBackground),
  });
}

export function queueWatchdogTelemetry(record: QueueFields): QueueEvent {
  const level = record.stage === "late_settle" ? "info" : "warn";
  return event(level, QUEUE_WATCHDOG_EVENT, {
    conversation_id: record.conversationId,
    stage: record.stage,
    active_lane: record.activeLane,
    active_source: record.activeSource,
    active_runtime_ms: roundedMilliseconds(record.activeRuntimeMs),
    waiting_user_age_ms: maybeRoundedMilliseconds(record.waitingUserAgeMs),
    interrupted: maybeText(record.interrupted),
  });
}

export function ackObligationTelemetry(record: QueueFields): QueueEvent {
  const level = record.outcome === "lost" ? "warn" : "info";
  return event(level, ACK_OBLIGATION_EVENT, {
    conversation_id: record.conversationId,
    outcome: record.outcome,
    age_ms: maybeRoundedMilliseconds(record.ageMs),
    coalesced_count: maybeText(record.coalescedCount),
    redrive_attempts: maybeText(record.redriveAttempts),
    time_to_first_visible_ack_ms: maybeRoundedMilliseconds(record.timeToFirstVisibleAckMs),
    interrupt_to_replacement_ack_ms: maybeRoundedMilliseconds(record.interruptToReplacementAckMs),
    reason: record.reason,
  });
}

export function pendingWakeTelemetry(record: QueueFields): QueueEvent {
  const level = record.outcome === "persist_failed"
    || record.outcome === "rearm_failed"
    || record.outcome === "pruned"
    ? "warn"
    : "info";
  return event(level, PENDING_WAKE_EVENT, {
    conversation_id: record.conversationId,
    outcome: record.outcome,
    kind: record.kind,
    work_id: record.workId,
    age_ms: maybeRoundedMilliseconds(record.ageMs),
    reason: record.reason,
    quiet_origin: nullableText(record.isQuietOrigin),
  });
}
