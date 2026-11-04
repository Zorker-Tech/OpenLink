import { slateMessageLengthBucket } from "../ports/slate-analytics-types.ts"
import type { CredentialRenewal, MessageSentAnalyticsInput, ProductAnalyticsPort } from "./host-telemetry-contracts.ts"
import type { SlateStructuredLogTelemetry } from "./structured-log-telemetry.ts"

/** Attach a renewal listener and replay the newest event that happened before subscription. */
export function watchCredentialRenewals(
  auth: {
    subscribeToRenewal(listener: (result: CredentialRenewal) => void): () => void
    getLastRenewalEvent(): CredentialRenewal | null
  },
  logs: SlateStructuredLogTelemetry,
): () => void {
  const report = (event: CredentialRenewal): void =>
    logs.reportInferenceCredentialRenewal(event.outcome === "failed" ? "error" : "info", {
      outcome: event.outcome,
      consecutive_failures: String(event.consecutiveFailures),
      duration_ms: String(event.durationMs),
      error_summary: event.errorSummary,
    })
  const unsubscribe = auth.subscribeToRenewal(report)
  const lastEvent = auth.getLastRenewalEvent()
  if (lastEvent !== null) report(lastEvent)
  return unsubscribe
}

export function recordMessageSentAnalytics(
  analytics: ProductAnalyticsPort,
  input: MessageSentAnalyticsInput,
): void {
  const body = typeof input.prompt === "string" ? input.prompt.trim() : ""
  const charCount = body.length
  analytics.markActive("user_action")
  analytics.trackEvent("slate.message.sent", {
    agent_id: input.agentId,
    char_count: charCount,
    length_bucket: slateMessageLengthBucket(charCount),
    attachment_count: Array.isArray(input.attachmentPaths) ? input.attachmentPaths.length : 0,
    has_rich_text: typeof input.richText === "string" && input.richText.length > 0,
    is_fork: input.isFork === true,
    source: typeof input.source === "string" ? input.source : "desktop",
    is_group_room: input.isGroupRoom === true,
  })
}
