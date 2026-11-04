export const TURN_EMPTY_DELIVERY_EVENT = "slate.turn.empty_delivery"

interface DeliveryIdentity {
  conversationId: string
  requestId?: string
  source: string
  requestSource?: string
}

interface RecoveryAttemptCounts {
  replyNudgeAttempts?: number
  redriveAttempts?: number
}

interface DeliveryOutcome {
  toolCallCount: number
  streamOutputProduced: boolean
  durationMs: number
  ackOutstanding: boolean
}

export type TurnEmptyDeliveryReport = DeliveryIdentity & RecoveryAttemptCounts & DeliveryOutcome

const METADATA_FIELDS: readonly (readonly [keyof TurnEmptyDeliveryReport, string])[] = [
  ["conversationId", "conversation_id"],
  ["requestId", "request_id"],
  ["source", "source"],
  ["requestSource", "request_source"],
  ["replyNudgeAttempts", "reply_nudge_attempts"],
  ["redriveAttempts", "redrive_attempts"],
  ["toolCallCount", "tool_call_count"],
  ["streamOutputProduced", "stream_output_produced"],
  ["durationMs", "duration_ms"],
  ["ackOutstanding", "ack_outstanding"],
]

function telemetryValue(report: TurnEmptyDeliveryReport, field: keyof TurnEmptyDeliveryReport): string | undefined {
  const value = report[field]
  if (value === undefined) return undefined
  if (field === "durationMs" && typeof value === "number") return String(Math.round(value))
  return String(value)
}

function metadataFor(report: TurnEmptyDeliveryReport): Record<string, string | undefined> {
  return Object.fromEntries(METADATA_FIELDS.map(([field, key]) => [key, telemetryValue(report, field)]))
}

export function turnEmptyDeliveryTelemetry(report: TurnEmptyDeliveryReport) {
  return {
    level: "warn",
    event: TURN_EMPTY_DELIVERY_EVENT,
    metadata: metadataFor(report),
  }
}
