export interface AnalyticsClient {
  trackEvent(name: string, properties: Record<string, string | number | boolean>): void
}

export interface AutomationRunAnalyticsReport {
  conversationId: string
  automationId: string
  trigger: string
  outcome: string
  isGroup: boolean
  sentMessageCount?: number | null
}

type ReportMethod = (...args: never[]) => unknown

/** The exact no-op/event surface consumed by the host agent runtime. */
export interface TelemetryService {
  startTurn: ReportMethod
  reportToolCallError: ReportMethod
  reportToolCallStalled: ReportMethod
  reportToolCallStarted: ReportMethod
  reportAgentError: ReportMethod
  reportBotBlock: ReportMethod
  reportDaemonPing: ReportMethod
  reportBoxBootStage: ReportMethod
  reportExecDaemonRestart: ReportMethod
  reportSupervisorRestart: ReportMethod
  reportTurnInterrupt: ReportMethod
  reportTurnAwait: ReportMethod
  reportTurnRetry: ReportMethod
  reportUserMessageReceived: ReportMethod
  reportClosingSendNudge: ReportMethod
  reportSubagentRevival: ReportMethod
  reportShellRevival: ReportMethod
  reportComputerUseUsage: ReportMethod
  reportTtft: ReportMethod
  reportSendDispatch: ReportMethod
  reportQueueAccepted: ReportMethod
  reportQueueDequeued: ReportMethod
  reportQueueWatchdog: ReportMethod
  reportAckObligation: ReportMethod
  reportPendingWake: ReportMethod
  reportTurnUsage: ReportMethod
  reportTurnEmptyDelivery: ReportMethod
  reportJournalOutcome: ReportMethod
  reportAutoReviewExpireSweepFailed: ReportMethod
  reportAutomationLifecycle: ReportMethod
  reportAutomationFireDropped: ReportMethod
  reportAutomationRun: ReportMethod
}
