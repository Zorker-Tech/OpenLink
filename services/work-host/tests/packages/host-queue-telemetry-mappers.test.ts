import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACK_OBLIGATION_EVENT,
  ackObligationTelemetry,
  PENDING_WAKE_EVENT,
  pendingWakeTelemetry,
  QUEUE_ACCEPTED_EVENT,
  QUEUE_DEQUEUED_EVENT,
  QUEUE_WATCHDOG_EVENT,
  queueAcceptedTelemetry,
  queueDequeuedTelemetry,
  queueWatchdogTelemetry,
  sendDispatchTelemetry,
  SEND_DISPATCH_EVENT,
} from "../../source/host/telemetry/queue-telemetry-mappers.ts";

describe("the queue telemetry event names", () => {
  it("use Slate-owned names for the queue and acknowledgements", () => {
    assert.deepEqual([
      SEND_DISPATCH_EVENT,
      QUEUE_ACCEPTED_EVENT,
      QUEUE_DEQUEUED_EVENT,
      QUEUE_WATCHDOG_EVENT,
      ACK_OBLIGATION_EVENT,
      PENDING_WAKE_EVENT,
    ], [
      "slate.send_dispatch",
      "slate.queue.accepted",
      "slate.queue.dequeued",
      "slate.queue.watchdog",
      "slate.ack.obligation",
      "slate.pending_wake",
    ]);
  });
});

describe("mapping queue telemetry", () => {
  it("rounds dispatch timing and preserves its accompanying fields", () => {
    assert.deepEqual(sendDispatchTelemetry({
      conversationId: "c1",
      dispatchMs: 12.6,
      hostDispatchMs: 10.4,
      skew: 2,
      skewReason: "clock",
      skewBucket: "small",
      isFork: true,
      modelId: "m1",
      traceId: "t1",
      spanId: "s1",
    }), {
      level: "info",
      event: SEND_DISPATCH_EVENT,
      metadata: {
        conversation_id: "c1",
        send_dispatch_ms: "13",
        send_dispatch_host_ms: "10",
        skew: "2",
        skew_reason: "clock",
        skew_bucket: "small",
        is_fork: "true",
        model_id: "m1",
        trace_id: "t1",
        span_id: "s1",
      },
    });
    assert.equal(sendDispatchTelemetry({ hostDispatchMs: 1, isFork: false }).metadata.send_dispatch_ms, undefined);
    assert.equal(sendDispatchTelemetry({ dispatchMs: null }).metadata.send_dispatch_ms, "0");
  });

  it("records queue admission depths as text", () => {
    assert.deepEqual(queueAcceptedTelemetry({
      conversationId: "c1",
      lane: "user",
      source: "typed",
      position: 2,
      depthUser: 3,
      depthAgent: 4,
      depthBackground: 5,
      hasActive: false,
    }), {
      level: "info",
      event: QUEUE_ACCEPTED_EVENT,
      metadata: {
        conversation_id: "c1",
        lane: "user",
        source: "typed",
        position: "2",
        depth_user: "3",
        depth_agent: "4",
        depth_background: "5",
        has_active: "false",
      },
    });
  });

  it("maps dequeue timing, with the optional accepted-to-run value", () => {
    const event = queueDequeuedTelemetry({
      conversationId: "c2",
      lane: "background",
      source: "wake",
      queueWaitMs: 15.6,
      acceptedToRunMs: 20.4,
      jumpedBackground: true,
      depthUser: 1,
      depthAgent: 2,
      depthBackground: 3,
    });
    assert.deepEqual(event, {
      level: "info",
      event: QUEUE_DEQUEUED_EVENT,
      metadata: {
        conversation_id: "c2",
        lane: "background",
        source: "wake",
        queue_wait_ms: "16",
        accepted_to_run_ms: "20",
        jumped_background: "true",
        depth_user: "1",
        depth_agent: "2",
        depth_background: "3",
      },
    });
    assert.equal(queueDequeuedTelemetry({ queueWaitMs: 0 }).metadata.accepted_to_run_ms, undefined);
    assert.equal(queueDequeuedTelemetry({ queueWaitMs: 0, acceptedToRunMs: null }).metadata.accepted_to_run_ms, "0");
  });

  it("warns for a missed watchdog action but reports a late settle as info", () => {
    const fields = {
      stage: "late_settle",
      activeLane: "agent",
      activeSource: "tool",
      activeRuntimeMs: 11.8,
      waitingUserAgeMs: 4.3,
      interrupted: false,
    };
    assert.deepEqual(queueWatchdogTelemetry(fields), {
      level: "info",
      event: QUEUE_WATCHDOG_EVENT,
      metadata: {
        conversation_id: undefined,
        stage: "late_settle",
        active_lane: "agent",
        active_source: "tool",
        active_runtime_ms: "12",
        waiting_user_age_ms: "4",
        interrupted: "false",
      },
    });
    assert.equal(queueWatchdogTelemetry({ stage: "timeout" }).level, "warn");
    assert.equal(queueWatchdogTelemetry({ stage: "timeout" }).metadata.waiting_user_age_ms, undefined);
    assert.equal(queueWatchdogTelemetry({ stage: "timeout", interrupted: null }).metadata.interrupted, "null");
  });

  it("marks a lost acknowledgement as warning and stringifies optional numbers", () => {
    assert.deepEqual(ackObligationTelemetry({
      conversationId: "c3",
      outcome: "lost",
      ageMs: 9.6,
      coalescedCount: 2,
      redriveAttempts: 3,
      timeToFirstVisibleAckMs: 1.2,
      interruptToReplacementAckMs: 5.8,
      reason: "connection lost",
    }), {
      level: "warn",
      event: ACK_OBLIGATION_EVENT,
      metadata: {
        conversation_id: "c3",
        outcome: "lost",
        age_ms: "10",
        coalesced_count: "2",
        redrive_attempts: "3",
        time_to_first_visible_ack_ms: "1",
        interrupt_to_replacement_ack_ms: "6",
        reason: "connection lost",
      },
    });
    assert.equal(ackObligationTelemetry({ outcome: "delivered" }).level, "info");
  });

  it("warns when a pending wake is lost or cannot persist, and keeps quiet-origin state", () => {
    for (const outcome of ["persist_failed", "rearm_failed", "pruned"]) {
      assert.equal(pendingWakeTelemetry({ outcome }).level, "warn", outcome);
    }
    assert.deepEqual(pendingWakeTelemetry({
      conversationId: "c4",
      outcome: "scheduled",
      kind: "reminder",
      workId: "w1",
      ageMs: 1.6,
      reason: "idle",
      isQuietOrigin: false,
    }), {
      level: "info",
      event: PENDING_WAKE_EVENT,
      metadata: {
        conversation_id: "c4",
        outcome: "scheduled",
        kind: "reminder",
        work_id: "w1",
        age_ms: "2",
        reason: "idle",
        quiet_origin: "false",
      },
    });
    assert.equal(pendingWakeTelemetry({ outcome: "scheduled", isQuietOrigin: null }).metadata.quiet_origin, undefined);
  });
});
