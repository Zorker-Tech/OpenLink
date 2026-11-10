export {
  SLATE_AUTOMATION_FIRE_DROPPED_EVENT,
  SLATE_AUTOMATION_LATE_FIRE_THRESHOLD_MS,
  SLATE_AUTOMATION_RUN_EVENT,
  isAutomationRunLate,
} from "./automation-fire-policy.ts"
export {
  projectAutomationRunTelemetry,
  projectDroppedAutomationFire,
} from "./automation-fire-telemetry-projection.ts"
export type {
  AutomationRunTelemetryInput,
  DroppedAutomationFireTelemetryInput,
} from "./automation-fire-contracts.ts"
