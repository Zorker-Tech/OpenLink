/**
 * What is reported when a connector authenticates.
 *
 * A connector is reported by a tag from a fixed set, so a report can be grouped without carrying a name the user
 * chose; anything not in the set is reported as some other connector, and a report with no name at all as unknown. A
 * failure or a timeout is a warning and everything else is information.
 */
import { brandedId } from "../errors/bounded-values.ts";
import { slateErrorTags, type SlateErrorValue } from "../errors/registry.ts";

export const KNOWN_CONNECTOR_TAGS = new Set(["asana", "atlassian", "buildkite", "confluence", "context7", "databricks", "datadog", "deepwiki", "dock", "figma", "filesystem", "github", "gmail", "google", "googlecalendar", "googledocs", "googledrive", "googlesheets", "googleworkspace", "huggingface", "jira", "linear", "memory", "notion", "playwright", "salesforce", "sentry", "sequentialthinking", "slack", "stripe", "telegram", "todoist", "zoominfo"]);
export const OTHER_CONNECTOR_TAG = "other";
export const UNKNOWN_CONNECTOR_TAG = "unknown";
export function boundedConnectorTag(serverName?: string): string {
  if (serverName === undefined) return UNKNOWN_CONNECTOR_TAG;
  const normalized = serverName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.length === 0 ? UNKNOWN_CONNECTOR_TAG : KNOWN_CONNECTOR_TAGS.has(normalized) ? normalized : OTHER_CONNECTOR_TAG;
}
export interface ConnectorAuthReport { readonly phase: string; readonly outcome: string; readonly serverName?: string; readonly serverId?: string; readonly reauth?: boolean; readonly error?: SlateErrorValue }
export function connectorAuthTelemetry(report: ConnectorAuthReport, surface: string): { level: "info" | "warn"; metadata: Record<string, string | undefined> } {
  return { level: report.outcome === "failed" || report.outcome === "timeout" ? "warn" : "info", metadata: { phase: report.phase, connector: boundedConnectorTag(report.serverName), outcome: report.outcome, surface, server_id: brandedId(report.serverId), reauth: report.reauth === undefined ? undefined : String(report.reauth), ...(report.error === undefined ? {} : slateErrorTags(report.error)) } };
}
