/** An automation's shadow prune, in the shape the telemetry backend reports it: a failed prune is a warning, everything else informational. */
export const AUTOMATION_SHADOW_PRUNE_EVENT = "slate.automation.shadow_prune";
export interface AutomationShadowPruneReport {
  outcome: string;
  conversationId: string;
  automationId: string;
  localDefinitionState: string;
  localDefinitionCount: number;
  desiredCount: number;
  remoteShadowCount: number;
  boxUptimeMs?: number | null;
}
export function automationShadowPruneTelemetry(
  report: AutomationShadowPruneReport,
) {
  return {
    level: report.outcome === "failed" ? "warn" : "info",
    event: AUTOMATION_SHADOW_PRUNE_EVENT,
    metadata: {
      conversation_id: report.conversationId,
      automation_id: report.automationId,
      outcome: report.outcome,
      local_definition_state: report.localDefinitionState,
      local_definition_count: String(report.localDefinitionCount),
      desired_count: String(report.desiredCount),
      remote_shadow_count: String(report.remoteShadowCount),
      box_uptime_ms:
        report.boxUptimeMs != null ? String(report.boxUptimeMs) : undefined,
    },
  };
}
