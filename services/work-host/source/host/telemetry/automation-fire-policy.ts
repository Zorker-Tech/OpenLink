import type { AutomationRunTelemetryInput } from "./automation-fire-contracts.ts"

export const SLATE_AUTOMATION_LATE_FIRE_THRESHOLD_MS = 5 * 60_000
export const SLATE_AUTOMATION_RUN_EVENT = "slate.automation.run"
export const SLATE_AUTOMATION_FIRE_DROPPED_EVENT = "slate.automation.fire_dropped"

export function isAutomationRunLate(report: AutomationRunTelemetryInput): boolean {
  return report.latenessMs != null && report.latenessMs >= SLATE_AUTOMATION_LATE_FIRE_THRESHOLD_MS
}
