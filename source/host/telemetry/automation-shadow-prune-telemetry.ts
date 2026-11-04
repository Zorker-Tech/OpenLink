export const AUTOMATION_SHADOW_PRUNE_EVENT = "slate.automation.shadow_prune";

interface AutomationIdentity {
  outcome: string;
  conversationId: string;
  automationId: string;
  localDefinitionState: string;
}

interface ShadowDefinitionCounts {
  localDefinitionCount: number;
  desiredCount: number;
  remoteShadowCount: number;
}

export interface AutomationShadowPruneReport extends AutomationIdentity, ShadowDefinitionCounts {
  boxUptimeMs?: number | null;
}

function severityFor(outcome: string): "warn" | "info" {
  return outcome === "failed" ? "warn" : "info";
}

function stringifyCounts(values: readonly (readonly [string, number])[]): Record<string, string> {
  return Object.fromEntries(values.map(([key, value]) => [key, String(value)]));
}

function reportMetadata(report: AutomationShadowPruneReport): Record<string, string | undefined> {
  return {
    conversation_id: report.conversationId,
    automation_id: report.automationId,
    outcome: report.outcome,
    local_definition_state: report.localDefinitionState,
    ...stringifyCounts([
      ["local_definition_count", report.localDefinitionCount],
      ["desired_count", report.desiredCount],
      ["remote_shadow_count", report.remoteShadowCount],
    ]),
    box_uptime_ms: report.boxUptimeMs != null ? String(report.boxUptimeMs) : undefined,
  };
}

export function automationShadowPruneTelemetry(report: AutomationShadowPruneReport) {
  return {
    level: severityFor(report.outcome),
    event: AUTOMATION_SHADOW_PRUNE_EVENT,
    metadata: reportMetadata(report),
  };
}
