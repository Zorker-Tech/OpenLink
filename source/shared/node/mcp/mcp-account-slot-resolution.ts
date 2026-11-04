import { normalizeAccountLabel } from "./mcp-account-display-policy.ts";
import { SlateMcpConfigError } from "./mcp-config-error.ts";
import { validateMcpServerId } from "./mcp-server-id.ts";
import type { McpAccountSlotLifecycleDependencies } from "./mcp-account-slot-contracts.ts";

export interface OAuthAccountServer {
  readonly serverId: string;
  readonly serverUrl: string;
}

export function normalizeAccountSlotKey(value: string): string {
  return normalizeAccountLabel(value);
}

export async function resolveOAuthAccountServer(
  dependencies: McpAccountSlotLifecycleDependencies,
  rawId: string,
): Promise<OAuthAccountServer> {
  const serverId = validateMcpServerId(rawId);
  const server = await dependencies.resolveDisplayServer(serverId);
  if (server == null) throw new SlateMcpConfigError("MCP server not found.");
  if (!("url" in server.config)) throw new SlateMcpConfigError("This connector runs on Slate's computer and has no OAuth accounts.");
  return { serverId, serverUrl: server.config.url };
}
