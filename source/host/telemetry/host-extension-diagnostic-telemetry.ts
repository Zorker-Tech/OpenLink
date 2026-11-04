/** A diagnostic the host may receive from one of its extensions. */
export type HostExtensionDiagnostic = {
  extension: string;
  [key: string]: unknown;
};

type DiagnosticLevel = "info" | "warn" | "error";
type FieldReader = (diagnostic: HostExtensionDiagnostic) => unknown;
type DiagnosticField = readonly [name: string, read: FieldReader];

interface DiagnosticEventRule {
  event: string;
  level(diagnostic: HostExtensionDiagnostic): DiagnosticLevel;
  fields: readonly DiagnosticField[];
}

const readValue = (field: string): FieldReader => diagnostic => diagnostic[field];
const readText = (field: string): FieldReader => diagnostic => String(diagnostic[field]);
const fixedLevel = (level: DiagnosticLevel): DiagnosticEventRule["level"] => () => level;

/** The fields each extension contributes to Slate's structured event. */
const eventRuleByExtension: ReadonlyMap<string, DiagnosticEventRule> = new Map([
  ["box_store", {
    level: fixedLevel("warn"),
    event: "slate.box_store.diagnostic",
    fields: [["kind", readValue("kind")], ["error_class", readValue("errorClass")]],
  }],
  ["automation_cloud_sync", {
    level: fixedLevel("error"),
    event: "slate.automation.cloud_sync",
    fields: [
      ["operation", readValue("operation")],
      ["agent_id", readValue("agentId")],
      ["error_type", readValue("errorType")],
      ["error_code", readValue("errorCode")],
    ],
  }],
  ["managed_setup", {
    level: diagnostic => diagnostic.kind === "managed_skills" ? "error" : "warn",
    event: "slate.managed_setup.load_failed",
    fields: [["kind", readValue("kind")], ["error_class", readValue("errorClass")]],
  }],
  ["attachments", {
    level: fixedLevel("warn"),
    event: "slate.attachment.read_miss",
    fields: [["kind", readValue("kind")], ["has_active", readText("hasActive")]],
  }],
  ["action_audit", {
    level: fixedLevel("error"),
    event: "slate.action_audit.drop",
    fields: [["error_class", readValue("errorClass")]],
  }],
  ["mcp", {
    level: fixedLevel("info"),
    event: "slate.mcp.host_edge_failed",
    fields: [["leg", readValue("leg")], ["error_class", readValue("errorClass")]],
  }],
]);

export function hostExtensionDiagnosticTelemetry(diagnostic: HostExtensionDiagnostic) {
  const rule = eventRuleByExtension.get(diagnostic.extension);
  if (rule === undefined) return undefined;

  const metadata: Record<string, unknown> = {};
  for (const [name, read] of rule.fields) {
    metadata[name] = read(diagnostic);
  }

  return {
    level: rule.level(diagnostic),
    event: rule.event,
    metadata,
  };
}
