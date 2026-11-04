export interface AutomationRunTelemetryInput {
  conversationId: string
  automationId: string
  trigger: string
  outcome: string
  isGroup: boolean
  durationMs: number
  latenessMs?: number | null
  scheduledForMs?: number | null
  sentMessageCount?: number | null
  eventBatchSize?: number | null
}

export interface DroppedAutomationFireTelemetryInput {
  conversationId: string
  trigger: string
  reason: string
  scheduledForMs?: number | null
  latenessMs?: number | null
  errorType?: string
  errorCode?: string
  runUuid?: string
  fireAgeMs?: number | null
  hasDefinitionRevision?: boolean | null
  boxUptimeMs?: number | null
}
