import { slateErrorTags, type SlateErrorValue } from "../../shared/errors/registry.ts"
import type { StartupPhaseReport } from "./host-lifecycle-progress.ts"
import { HOST_LIFECYCLE_EVENT, HOST_STARTUP_EVENT } from "./lifecycle-event-names.ts"

export function hostStartupTelemetry(metadata: Record<string, string>, hostBuiltAtMs: string) {
  return {
    level: "info",
    event: HOST_STARTUP_EVENT,
    metadata: { host_built_at_ms: hostBuiltAtMs, ...metadata },
  }
}

function lifecycleLevel(outcome: StartupPhaseReport["outcome"]): "info" | "warn" | "error" {
  if (outcome === "stuck") return "warn"
  if (outcome === "failed") return "error"
  return "info"
}

function lifecycleErrorTags(report: StartupPhaseReport): Record<string, string> {
  return report.outcome === "completed" ? {} : slateErrorTags(report.error)
}

export function hostLifecycleTelemetry(report: StartupPhaseReport) {
  const pluginCount = report.outcome === "completed" && report.phase === "plugin_graph"
    ? String(report.pluginCount)
    : undefined
  const entryCount = report.outcome === "completed" && report.phase === "transcript_read"
    ? String(report.entryCount)
    : undefined

  return {
    level: lifecycleLevel(report.outcome),
    event: HOST_LIFECYCLE_EVENT,
    metadata: {
      phase: report.phase,
      outcome: report.outcome,
      duration_ms: String(report.durationMs),
      plugin_count: pluginCount,
      entry_count: entryCount,
      ...lifecycleErrorTags(report),
    },
  }
}
