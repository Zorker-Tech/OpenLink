import { DEFAULT_MCP_ACCOUNT_KEY, provisionalMcpAccountServerIdentifier } from "../../mcp.ts";
import { resolveMcpCustomInstruction } from "../../mcp-custom-instructions.ts";
import { getCommand, getTransport } from "./mcp-validation.ts";
import { projectPluginAttribution } from "./mcp-account-display-policy.ts";
import { projectBackendServerStatus, projectBoxServerStatus } from "./mcp-server-status-projection.ts";
import type {
  BackendMcpEntry,
  BoxMcpEntry,
  McpAccountSlot,
  McpListingSummaryDependencies,
  McpSummaryServer,
} from "./mcp-listing-summary-contracts.ts";

function enabledToolCount(serverId: string, tools: readonly { readonly toolName: string }[], dependencies: McpListingSummaryDependencies): number {
  const disabledTools = dependencies.settingsStore().getMcpDisabledToolsByServerId()[serverId] ?? [];
  return disabledTools.length === 0 ? tools.length : tools.filter(({ toolName }) => !disabledTools.includes(toolName)).length;
}

function instructionFor(server: McpSummaryServer, dependencies: McpListingSummaryDependencies): string {
  const settings = dependencies.settingsStore();
  const stored = settings.getRawMcpCustomInstructionByServerId(server.id) ?? settings.getRawMcpCustomInstruction(server.name);
  return resolveMcpCustomInstruction(server.name, stored);
}

function displayRowId(server: McpSummaryServer): string {
  return server.serverIdentifier ?? `mcp-row-${server.id}`;
}

export function backendAccountSummary(
  server: McpSummaryServer,
  backend: BackendMcpEntry | undefined,
  accountKey: string,
  slot: McpAccountSlot | undefined,
  dependencies: McpListingSummaryDependencies,
) {
  const rowIdentifier = displayRowId(server);
  const tools = backend?.tools ?? [];
  const toolCount = enabledToolCount(server.id, tools, dependencies);
  const disabledToolCount = tools.length - toolCount;
  const status = slot != null && !slot.hasToken
    ? { status: "needsAuth", statusDetail: "Authentication required" }
    : projectBackendServerStatus(backend?.status);

  return {
    id: server.id,
    name: server.name,
    serverIdentifier: slot?.serverIdentifier ?? backend?.serverIdentifier ?? provisionalMcpAccountServerIdentifier(rowIdentifier, accountKey),
    accountKey,
    rowServerIdentifier: rowIdentifier,
    transport: getTransport(server.config),
    command: getCommand(server.config),
    url: "url" in server.config ? server.config.url : undefined,
    toolCount,
    ...(disabledToolCount > 0 ? { disabledToolCount } : {}),
    customInstructions: instructionFor(server, dependencies),
    isTeamServer: server.isTeamServer,
    ...projectPluginAttribution(server),
    ...status,
  };
}

export function boxServerSummary(
  server: McpSummaryServer,
  box: BoxMcpEntry | undefined,
  unavailable: boolean,
  dependencies: McpListingSummaryDependencies,
) {
  const rowIdentifier = displayRowId(server);
  const boxTools = box?.tools ?? [];
  const toolCount = box == null
    ? 0
    : boxTools.length > 0
      ? enabledToolCount(server.id, boxTools, dependencies)
      : box.toolCount;
  const disabledToolCount = box == null || boxTools.length === 0 ? 0 : boxTools.length - toolCount;
  const status = dependencies.isBoxExecWired()
    ? projectBoxServerStatus(box?.status, unavailable, box?.statusDetail)
    : { status: "disconnected", statusDetail: "Runs on Slate's computer" };

  return {
    id: server.id,
    name: server.name,
    serverIdentifier: rowIdentifier,
    accountKey: DEFAULT_MCP_ACCOUNT_KEY,
    rowServerIdentifier: rowIdentifier,
    transport: getTransport(server.config),
    command: getCommand(server.config),
    url: undefined,
    toolCount,
    ...(disabledToolCount > 0 ? { disabledToolCount } : {}),
    customInstructions: instructionFor(server, dependencies),
    isTeamServer: server.isTeamServer,
    ...projectPluginAttribution(server),
    ...status,
  };
}

export function adminDisabledServerSummary(server: McpSummaryServer, dependencies: McpListingSummaryDependencies) {
  const rowIdentifier = displayRowId(server);
  return {
    id: server.id,
    name: server.name,
    serverIdentifier: rowIdentifier,
    accountKey: DEFAULT_MCP_ACCOUNT_KEY,
    rowServerIdentifier: rowIdentifier,
    transport: getTransport(server.config),
    command: getCommand(server.config),
    url: "url" in server.config ? server.config.url : undefined,
    toolCount: 0,
    customInstructions: instructionFor(server, dependencies),
    isTeamServer: server.isTeamServer,
    ...projectPluginAttribution(server),
    status: "disabledByTeamAdminPolicy",
    statusDetail: "Disabled by team admin",
  };
}
