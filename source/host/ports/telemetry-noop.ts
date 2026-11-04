export interface NoopTelemetryTurn {
  setModel(): void
  setRequestId(): void
  finalize(): void
}

export const SLATE_NOOP_TELEMETRY_METHODS = [
  "reportToolCallError", "reportToolCallStalled", "reportToolCallStarted", "reportAgentError",
  "reportBotBlock", "reportDaemonPing", "reportBoxBootStage", "reportExecDaemonRestart",
  "reportSupervisorRestart", "reportAutomationRun", "reportAutomationFireDropped",
  "reportAutomationLifecycle", "reportTurnInterrupt", "reportTurnAwait", "reportTurnRetry",
  "reportUserMessageReceived", "reportClosingSendNudge", "reportSubagentRevival", "reportShellRevival",
  "reportComputerUseUsage", "reportTtft", "reportSendDispatch", "reportQueueAccepted",
  "reportQueueDequeued", "reportQueueWatchdog", "reportAckObligation", "reportPendingWake",
  "reportTurnUsage", "reportTurnEmptyDelivery", "reportJournalOutcome", "reportAutoReviewExpireSweepFailed",
] as const

export type SlateNoopTelemetry = {
  readonly startTurn: () => NoopTelemetryTurn
} & {
  readonly [Method in typeof SLATE_NOOP_TELEMETRY_METHODS[number]]: (...args: unknown[]) => void
}

const doNothing = (..._args: unknown[]): void => {}
const noopTurn: NoopTelemetryTurn = {
  setModel: doNothing,
  setRequestId: doNothing,
  finalize: doNothing,
}

export function createNoopSlateTelemetry(): SlateNoopTelemetry {
  const reporters = Object.fromEntries(SLATE_NOOP_TELEMETRY_METHODS.map((method) => [method, doNothing]))
  return Object.assign({ startTurn: () => noopTurn }, reporters) as SlateNoopTelemetry
}
