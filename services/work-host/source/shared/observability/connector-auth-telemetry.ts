/**
 * What is reported when a connector authenticates.
 *
 * A connector is reported by a tag from a fixed set, so a report can be grouped without carrying a name the user
 * chose; anything not in the set is reported as some other connector, and a report with no name at all as unknown. A
 * failure or a timeout is a warning and everything else is information.
 */
import { brandedId } from "../errors/bounded-values.ts";
import { slateErrorTags, type SlateErrorValue } from "../errors/registry.ts";
import { boundedConnectorTag } from "../../adapters/interop/mcp/connector-auth-tag-adapter.ts";

export interface ConnectorAuthReport { readonly phase: string; readonly outcome: string; readonly serverName?: string; readonly serverId?: string; readonly reauth?: boolean; readonly error?: SlateErrorValue }
export function connectorAuthTelemetry(report: ConnectorAuthReport, surface: string): { level: "info" | "warn"; metadata: Record<string, string | undefined> } {
  const isWarning = report.outcome === "failed" || report.outcome === "timeout";
  const metadata = {
    phase: report.phase,
    connector: boundedConnectorTag(report.serverName),
    outcome: report.outcome,
    surface,
    server_id: brandedId(report.serverId),
    reauth: report.reauth === undefined ? undefined : String(report.reauth),
    ...(report.error === undefined ? {} : slateErrorTags(report.error)),
  };
  return { level: isWarning ? "warn" : "info", metadata };
}
