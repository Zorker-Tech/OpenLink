/** A host extension's diagnostic, in the shape the telemetry backend takes: the event and level depend on which extension reported it. */
export type HostExtensionDiagnostic = {
  extension: string;
  [key: string]: unknown;
};
export function hostExtensionDiagnosticTelemetry(
  diagnostic: HostExtensionDiagnostic,
) {
  switch (diagnostic.extension) {
    case "box_store":
      return {
        level: "warn",
        event: "slate.box_store.diagnostic",
        metadata: { kind: diagnostic.kind, error_class: diagnostic.errorClass },
      };
    case "automation_cloud_sync":
      return {
        level: "error",
        event: "slate.automation.cloud_sync",
        metadata: {
          operation: diagnostic.operation,
          agent_id: diagnostic.agentId,
          error_type: diagnostic.errorType,
          error_code: diagnostic.errorCode,
        },
      };
    case "managed_setup":
      return {
        level: diagnostic.kind === "managed_skills" ? "error" : "warn",
        event: "slate.managed_setup.load_failed",
        metadata: { kind: diagnostic.kind, error_class: diagnostic.errorClass },
      };
    case "attachments":
      return {
        level: "warn",
        event: "slate.attachment.read_miss",
        metadata: {
          kind: diagnostic.kind,
          has_active: String(diagnostic.hasActive),
        },
      };
    case "action_audit":
      return {
        level: "error",
        event: "slate.action_audit.drop",
        metadata: { error_class: diagnostic.errorClass },
      };
    case "mcp":
      return {
        level: "info",
        event: "slate.mcp.host_edge_failed",
        metadata: { leg: diagnostic.leg, error_class: diagnostic.errorClass },
      };
    default:
      return undefined;
  }
}
