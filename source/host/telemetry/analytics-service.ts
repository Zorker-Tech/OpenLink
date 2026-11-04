import type {
  AnalyticsClient,
  AutomationRunAnalyticsReport,
  TelemetryService,
} from "./analytics-service-contracts.ts"

export type { AnalyticsClient, AutomationRunAnalyticsReport, TelemetryService } from "./analytics-service-contracts.ts"

const FORWARDED_METHODS = [
  "startTurn",
  "reportToolCallError",
  "reportToolCallStalled",
  "reportToolCallStarted",
  "reportAgentError",
  "reportBotBlock",
  "reportDaemonPing",
  "reportBoxBootStage",
  "reportExecDaemonRestart",
  "reportSupervisorRestart",
  "reportTurnInterrupt",
  "reportTurnAwait",
  "reportTurnRetry",
  "reportUserMessageReceived",
  "reportClosingSendNudge",
  "reportSubagentRevival",
  "reportShellRevival",
  "reportComputerUseUsage",
  "reportTtft",
  "reportSendDispatch",
  "reportQueueAccepted",
  "reportQueueDequeued",
  "reportQueueWatchdog",
  "reportAckObligation",
  "reportPendingWake",
  "reportTurnUsage",
  "reportTurnEmptyDelivery",
  "reportJournalOutcome",
  "reportAutoReviewExpireSweepFailed",
  "reportAutomationLifecycle",
  "reportAutomationFireDropped",
] as const satisfies readonly Exclude<keyof TelemetryService, "reportAutomationRun">[]

/** Forward methods explicitly because class prototype members do not appear in object enumeration. */
export function withAutomationRunAnalytics<T extends TelemetryService>(
  telemetry: T,
  analytics: AnalyticsClient,
): T {
  const forward = <Method extends Exclude<keyof TelemetryService, "reportAutomationRun">>(name: Method) => {
    type OriginalMethod = T[Method]
    return (...args: Parameters<OriginalMethod>): ReturnType<OriginalMethod> =>
      telemetry[name](...args) as ReturnType<OriginalMethod>
  }
  const forwarded = Object.fromEntries(FORWARDED_METHODS.map((name) => [name, forward(name)]))
  const reportAutomationRun = telemetry.reportAutomationRun as unknown as (
    report: AutomationRunAnalyticsReport,
  ) => unknown

  return {
    ...forwarded,
    reportAutomationRun: (report: AutomationRunAnalyticsReport) => {
      analytics.trackEvent("slate.automation.run", {
        agent_id: report.conversationId,
        automation_id: report.automationId,
        trigger: report.trigger,
        outcome: report.outcome,
        is_group: report.isGroup,
        ...(report.sentMessageCount == null ? {} : { sent_message_count: report.sentMessageCount }),
      })
      return reportAutomationRun(report)
    },
  } as unknown as T
}
