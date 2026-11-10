import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BOUNDED_ERROR_TYPE,
  TURN_AWAIT_EVENT,
  TURN_INTERRUPT_EVENT,
  TURN_RETRY_EVENT,
  TURN_USAGE_EVENT,
  TURN_USAGE_SCHEMA_VERSION,
  USER_MESSAGE_RECEIVED_EVENT,
  CLOSING_SEND_NUDGE_EVENT,
  COMPUTER_USE_USAGE_EVENT,
  TTFT_EVENT,
  closingSendNudgeTelemetry,
  computerUseUsageTelemetry,
  totalInputTokens,
  ttftTelemetry,
  turnAwaitTelemetry,
  turnInterruptTelemetry,
  turnRetryTelemetry,
  turnUsageTelemetry,
  usageTokenTags,
  userMessageReceivedTelemetry,
} from "../../source/host/telemetry/turn-telemetry-mappers.ts";

const usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 };

describe("mapping turn telemetry", () => {
  it("renders token usage tags", () => {
    assert.deepEqual(usageTokenTags(null), {});
    assert.deepEqual(usageTokenTags(usage), {
      input_tokens: "10", output_tokens: "20", cache_read_tokens: "3", cache_write_tokens: "4", reasoning_tokens: "5", total_input_tokens: "10",
    });
    assert.equal(totalInputTokens(usage), 10);
    const withoutReasoning = usageTokenTags({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.equal("reasoning_tokens" in withoutReasoning, true);
    assert.equal(withoutReasoning.reasoning_tokens, undefined);
  });

  it("maps the interrupt, await and user-message events", () => {
    assert.deepEqual(turnInterruptTelemetry({ conversationId: "c1", reason: "superseded", hadActiveRun: true, wasInFlight: false }), {
      level: "info", event: "slate.turn.interrupt",
      metadata: { conversation_id: "c1", reason: "superseded", had_active_run: "true", was_in_flight: "false" },
    });
    assert.deepEqual(turnAwaitTelemetry({ conversationId: "c1", blockUntilMs: 500, outcome: "ok", awaitIndex: 2 }), {
      level: "info", event: "slate.turn.await",
      metadata: { conversation_id: "c1", block_until_ms: "500", outcome: "ok", await_index: "2" },
    });
    assert.deepEqual(userMessageReceivedTelemetry({ conversationId: "c1", wasInFlight: true }), {
      level: "info", event: "slate.user_message.received", metadata: { conversation_id: "c1", was_in_flight: "true" },
    });
  });

  it("maps a retry with its bounded error type", () => {
    const retried = turnRetryTelemetry({ conversationId: "c1", outcome: "retried", attempt: 1, maxAttempts: 3, errorType: "ProviderOverloaded", errorCode: "overloaded", cause: "busy", delayMs: 12.6, serverPaced: true });
    assert.equal(retried.level, "info");
    assert.equal(retried.event, "slate.turn.retry");
    assert.equal(retried.metadata?.error_type, "ProviderOverloaded");
    assert.equal(retried.metadata?.delay_ms, "13");
    assert.equal(retried.metadata?.server_paced, "true");
    const exhausted = turnRetryTelemetry({ conversationId: "c1", outcome: "exhausted", attempt: 3, maxAttempts: 3, errorType: "bad type with spaces" });
    assert.equal(exhausted.level, "warn");
    assert.equal(exhausted.metadata?.error_type, "error");
    assert.equal(exhausted.metadata?.delay_ms, undefined);
    assert.equal(BOUNDED_ERROR_TYPE.test("A-b_c.d:e|f"), true);
    assert.equal(BOUNDED_ERROR_TYPE.test("x".repeat(65)), false);
    assert.equal(BOUNDED_ERROR_TYPE.test("bad type"), false);
  });

  it("maps the closing nudge with its warning level", () => {
    assert.deepEqual(closingSendNudgeTelemetry({ conversationId: "c1", delivered: false, aborted: false, sentMessageCount: 4 }), {
      level: "warn", event: "slate.turn.closing_send_nudge",
      metadata: { conversation_id: "c1", delivered: "false", sent_message_count: "4", aborted: "false" },
    });
    assert.equal(closingSendNudgeTelemetry({ conversationId: "c1", delivered: true, aborted: false, sentMessageCount: 1 }).level, "info");
    assert.equal(closingSendNudgeTelemetry({ conversationId: "c1", delivered: false, aborted: true, sentMessageCount: 1 }).level, "info");
  });

  it("maps ttft with its rounded latency", () => {
    const mapped = ttftTelemetry({ conversationId: "c1", ttftMs: 123.4, skew: 2, skewReason: "clock", chunkType: "text", isFork: true, modelId: "m1", traceId: "t1", spanId: "s1" });
    assert.equal(mapped.event, "slate.ttft");
    assert.equal(mapped.metadata?.ttft_ms, "123");
    assert.equal(mapped.metadata?.is_fork, "true");
    assert.equal(ttftTelemetry({ conversationId: "c1", skew: 0 }).metadata?.ttft_ms, undefined);
  });

  it("maps turn usage with its schema version", () => {
    const mapped = turnUsageTelemetry({ conversationId: "c1", source: "model", requestId: "r1", requestIdCount: 1, turnEndedSeq: 7, usage });
    assert.equal(mapped.event, "slate.turn.usage");
    assert.equal(mapped.metadata?.schema_version, "2");
    assert.equal(mapped.metadata?.has_request_id, "true");
    assert.equal(mapped.metadata?.has_usage, "true");
    assert.equal(mapped.metadata?.input_tokens, "10");
    const withoutUsage = turnUsageTelemetry({ conversationId: "c1", source: "model", turnEndedSeq: 0 });
    assert.equal(withoutUsage.metadata?.has_usage, "false");
    assert.equal(withoutUsage.metadata?.request_id, undefined);
  });

  it("maps computer-use usage with its error level", () => {
    const mapped = computerUseUsageTelemetry({ parentAgentId: "p", subagentAgentId: "s", subagentType: "type", subagentRequestId: "r", modelId: "m", outcome: "error", durationMs: 9.6, toolCallCount: 2, turnEndedCount: 1, usage });
    assert.equal(mapped.level, "warn");
    assert.equal(mapped.event, "slate.computer_use.usage");
    assert.equal(mapped.metadata?.duration_ms, "10");
    assert.equal(mapped.metadata?.schema_version, "1");
    assert.equal(computerUseUsageTelemetry({ outcome: "ok", durationMs: 1 }).level, "info");
  });
});
