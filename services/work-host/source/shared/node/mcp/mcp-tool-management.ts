import { displayRowOwnsIdentifier } from "./mcp-definition-source.ts";
import { SlateMcpConfigError } from "./mcp-config-error.ts";
import { validateMcpServerId } from "./mcp-server-id.ts";
import type { McpInstructionUpdate, McpToolToggle, SlateMcpInstructionsAndTogglesDependencies } from "./mcp-instructions-contracts.ts";

function displayRowForIdentifier(deps: SlateMcpInstructionsAndTogglesDependencies, identifier: string) {
  return deps.lastAccountDisplayConfig()?.servers.find((server) =>
    server.serverIdentifier != null && displayRowOwnsIdentifier(identifier, server.serverIdentifier, server.accounts),
  );
}

export async function setServerCustomInstructions(
  deps: SlateMcpInstructionsAndTogglesDependencies,
  request: McpInstructionUpdate,
): Promise<unknown> {
  const serverId = validateMcpServerId(request.serverId);
  const server = await deps.resolveDisplayServer(serverId);
  if (server == null) throw new SlateMcpConfigError("MCP server not found.");

  const nameCount = (deps.lastAccountDisplayConfig()?.servers ?? []).filter((entry) => entry.name === server.name).length;
  deps.settingsStore().setMcpCustomInstructionByServerId({
    serverId,
    displayName: server.name,
    value: request.instructions,
    mirrorLegacyName: nameCount <= 1,
  });
  return deps.listServers();
}

export async function listServerTools(
  deps: SlateMcpInstructionsAndTogglesDependencies,
  rawServerId: string,
): Promise<unknown[]> {
  const serverId = validateMcpServerId(rawServerId);
  if (await deps.resolveDisplayServer(serverId) == null) throw new SlateMcpConfigError("MCP server not found.");

  const disabledNames = deps.settingsStore().getMcpDisabledToolsByServerId()[serverId] ?? [];
  const toolsByName = new Map<string, unknown>();
  for (const tool of await deps.getToolsRaw()) {
    if (displayRowForIdentifier(deps, tool.providerIdentifier)?.id !== serverId || toolsByName.has(tool.toolName)) continue;
    toolsByName.set(tool.toolName, {
      name: tool.toolName,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      isDisabled: disabledNames.includes(tool.toolName),
    });
  }
  return [...toolsByName.values()];
}

export async function toggleMcpToolDisabled(
  deps: SlateMcpInstructionsAndTogglesDependencies,
  request: McpToolToggle,
): Promise<unknown[]> {
  const serverId = validateMcpServerId(request.serverId);
  if (request.toolName.length === 0) throw new SlateMcpConfigError("MCP tool name is required.");
  if (await deps.resolveDisplayServer(serverId) == null) throw new SlateMcpConfigError("MCP server not found.");

  const nextByServer = { ...deps.settingsStore().getMcpDisabledToolsByServerId() };
  const current = nextByServer[serverId] ?? [];
  nextByServer[serverId] = current.includes(request.toolName)
    ? current.filter((name) => name !== request.toolName)
    : [...current, request.toolName];
  deps.settingsStore().setMcpDisabledToolsByServerId(nextByServer);
  return listServerTools(deps, serverId);
}

export function deleteDisabledToolsForServer(
  deps: SlateMcpInstructionsAndTogglesDependencies,
  serverId: string,
): void {
  const disabledByServer = deps.settingsStore().getMcpDisabledToolsByServerId();
  if (disabledByServer[serverId] == null) return;
  const { [serverId]: _deleted, ...remaining } = disabledByServer;
  deps.settingsStore().setMcpDisabledToolsByServerId(remaining);
}
