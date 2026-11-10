import assert from "node:assert/strict"
import test from "node:test"

import {
  TURN_EMPTY_DELIVERY_EVENT,
  turnEmptyDeliveryTelemetry,
} from "../../source/host/telemetry/turn-empty-delivery-telemetry.ts"

test("empty-delivery reports map to the stable warning event shape", () => {
  assert.equal(TURN_EMPTY_DELIVERY_EVENT, "slate.turn.empty_delivery")
  assert.deepEqual(turnEmptyDeliveryTelemetry({
    conversationId: "conversation-7",
    requestId: "request-3",
    source: "ack-redrive",
    requestSource: "automation",
    replyNudgeAttempts: 2,
    redriveAttempts: 4,
    toolCallCount: 3,
    streamOutputProduced: false,
    durationMs: 12.6,
    ackOutstanding: true,
  }), {
    level: "warn",
    event: "slate.turn.empty_delivery",
    metadata: {
      conversation_id: "conversation-7",
      request_id: "request-3",
      source: "ack-redrive",
      request_source: "automation",
      reply_nudge_attempts: "2",
      redrive_attempts: "4",
      tool_call_count: "3",
      stream_output_produced: "false",
      duration_ms: "13",
      ack_outstanding: "true",
    },
  })
})

test("optional identifiers and retry counts stay present with undefined values", () => {
  const metadata = turnEmptyDeliveryTelemetry({
    conversationId: "conversation-8",
    source: "turn-runtime",
    toolCallCount: 0,
    streamOutputProduced: false,
    durationMs: 0,
    ackOutstanding: false,
  }).metadata

  assert.deepEqual(metadata, {
    conversation_id: "conversation-8",
    request_id: undefined,
    source: "turn-runtime",
    request_source: undefined,
    reply_nudge_attempts: undefined,
    redrive_attempts: undefined,
    tool_call_count: "0",
    stream_output_produced: "false",
    duration_ms: "0",
    ack_outstanding: "false",
  })
})
