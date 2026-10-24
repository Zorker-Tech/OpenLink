/**
 * A turn's own events, in the shape the telemetry backend takes: an interrupt, an await, a retry, a closing nudge and
 * the rest, each under its own event name.
 */
export const TURN_INTERRUPT_EVENT = "slate.turn.interrupt",
  TURN_AWAIT_EVENT = "slate.turn.await",
  TURN_RETRY_EVENT = "slate.turn.retry",
  CLOSING_SEND_NUDGE_EVENT = "slate.turn.closing_send_nudge",
  USER_MESSAGE_RECEIVED_EVENT = "slate.user_message.received",
  COMPUTER_USE_USAGE_EVENT = "slate.computer_use.usage",
  TTFT_EVENT = "slate.ttft",
  TURN_USAGE_EVENT = "slate.turn.usage",
  TURN_USAGE_SCHEMA_VERSION = "2";
export const BOUNDED_ERROR_TYPE = /^[0-9A-Za-z._|:-]{1,64}$/;
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}
type TurnTelemetryFields = Record<
  string,
  string | number | boolean | null | undefined | TokenUsage
>;
export function totalInputTokens(tokenUsage: TokenUsage): number {
  return tokenUsage.inputTokens;
}
export function usageTokenTags(tokenUsage: TokenUsage | null | undefined) {
  if (tokenUsage == null) return {};
  return {
    input_tokens: String(tokenUsage.inputTokens),
    output_tokens: String(tokenUsage.outputTokens),
    cache_read_tokens: String(tokenUsage.cacheReadTokens),
    cache_write_tokens: String(tokenUsage.cacheWriteTokens),
    reasoning_tokens:
      tokenUsage.reasoningTokens != null ? String(tokenUsage.reasoningTokens) : undefined,
    total_input_tokens: String(totalInputTokens(tokenUsage)),
  };
}
export function turnInterruptTelemetry(fields: TurnTelemetryFields) {
  return {
    level: "info",
    event: TURN_INTERRUPT_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      reason: fields.reason,
      had_active_run: String(fields.hadActiveRun),
      was_in_flight: String(fields.wasInFlight),
    },
  };
}
export function turnAwaitTelemetry(fields: TurnTelemetryFields) {
  return {
    level: "info",
    event: TURN_AWAIT_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      block_until_ms: String(fields.blockUntilMs),
      outcome: fields.outcome,
      await_index: String(fields.awaitIndex),
    },
  };
}
export function turnRetryTelemetry(fields: TurnTelemetryFields) {
  return {
    level: fields.outcome === "retried" ? "info" : "warn",
    event: TURN_RETRY_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      outcome: fields.outcome,
      attempt: String(fields.attempt),
      max_attempts: String(fields.maxAttempts),
      error_type: BOUNDED_ERROR_TYPE.test(String(fields.errorType))
        ? fields.errorType
        : "error",
      error_code: fields.errorCode,
      cause: fields.cause,
      delay_ms:
        fields.delayMs != null ? String(Math.round(fields.delayMs as number)) : undefined,
      server_paced: fields.serverPaced != null ? String(fields.serverPaced) : undefined,
    },
  };
}
export function userMessageReceivedTelemetry(fields: TurnTelemetryFields) {
  return {
    level: "info",
    event: USER_MESSAGE_RECEIVED_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      was_in_flight: String(fields.wasInFlight),
    },
  };
}
export function closingSendNudgeTelemetry(fields: TurnTelemetryFields) {
  return {
    level: !fields.delivered && !fields.aborted ? "warn" : "info",
    event: CLOSING_SEND_NUDGE_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      delivered: String(fields.delivered),
      sent_message_count: String(fields.sentMessageCount),
      aborted: String(fields.aborted),
    },
  };
}
export function ttftTelemetry(fields: TurnTelemetryFields) {
  return {
    level: "info",
    event: TTFT_EVENT,
    metadata: {
      conversation_id: fields.conversationId,
      ttft_ms:
        fields.ttftMs !== undefined
          ? String(Math.round(fields.ttftMs as number))
          : undefined,
      skew: String(fields.skew),
      skew_reason: fields.skewReason,
      chunk_type: fields.chunkType,
      is_fork: String(fields.isFork),
      model_id: fields.modelId,
      trace_id: fields.traceId,
      span_id: fields.spanId,
    },
  };
}
export function turnUsageTelemetry(fields: TurnTelemetryFields) {
  const tokenUsage = fields.usage as TokenUsage | null | undefined;
  return {
    level: "info",
    event: TURN_USAGE_EVENT,
    metadata: {
      schema_version: TURN_USAGE_SCHEMA_VERSION,
      conversation_id: fields.conversationId,
      source: fields.source,
      request_id: fields.requestId as string | undefined,
      has_request_id: String(fields.requestId != null),
      request_id_count: String(fields.requestIdCount),
      turn_ended_seq: String(fields.turnEndedSeq),
      has_usage: String(tokenUsage != null),
      ...usageTokenTags(tokenUsage),
    },
  };
}
export function computerUseUsageTelemetry(fields: TurnTelemetryFields) {
  const tokenUsage = fields.usage as TokenUsage | null | undefined;
  return {
    level: fields.outcome === "error" ? "warn" : "info",
    event: COMPUTER_USE_USAGE_EVENT,
    metadata: {
      schema_version: "1",
      parent_agent_id: fields.parentAgentId,
      subagent_agent_id: fields.subagentAgentId,
      subagent_type: fields.subagentType,
      request_id: fields.subagentRequestId,
      model_id: fields.modelId,
      outcome: fields.outcome,
      duration_ms: String(Math.round(fields.durationMs as number)),
      tool_call_count: String(fields.toolCallCount),
      turn_ended_count: String(fields.turnEndedCount),
      has_usage: String(tokenUsage != null),
      ...usageTokenTags(tokenUsage),
    },
  };
}
