import type { SlateMcpServerConfig } from "./mcp-display-runtime.ts";
import { McpAccountConfigCache } from "./mcp-definition-source-cache.ts";
import { EMPTY_MCP_CONFIG, type McpAccountConfigProvider, type McpRuntimeConfig } from "./mcp-definition-source-contracts.ts";
import {
  accountServerConfigs,
  serverDefinitions,
  serverUrlForIdentifier,
  stdioServerConfigs,
  visibleServerNames,
} from "./mcp-definition-source-projections.ts";
import { backendEntryBelongsToRow, displayRowOwnsIdentifier } from "./mcp-definition-source-identity.ts";

export { EMPTY_MCP_CONFIG, backendEntryBelongsToRow, displayRowOwnsIdentifier };
export type { McpAccountConfigProvider, McpRuntimeConfig };

export class SlateMcpDefinitionSource {
  private readonly accountConfig: McpAccountConfigCache;

  constructor(private readonly includeBuiltins: boolean, provider?: McpAccountConfigProvider) {
    this.accountConfig = new McpAccountConfigCache(provider);
  }

  peekHttpServerNames(): string[] | undefined {
    return visibleServerNames(this.accountConfig.lastKnown, "url");
  }

  peekStdioServerNames(): string[] | undefined {
    return visibleServerNames(this.accountConfig.lastKnown, "command");
  }

  getStdioServerConfigs(): Promise<Record<string, SlateMcpServerConfig & { command: string }>> {
    return stdioServerConfigs(this.accountConfig.current);
  }

  clearLastKnownAccountConfig(): void {
    this.accountConfig.clearLastKnown();
  }

  adoptAccountConfig(config: McpRuntimeConfig | null): void {
    this.accountConfig.adopt(config);
  }

  clearCache(): void {
    this.accountConfig.reload();
  }

  ensureConfigLoaded(): Promise<void> {
    return this.accountConfig.ensureLoaded();
  }

  refreshInBackground(): void {
    this.accountConfig.refreshInBackground();
  }

  getUserServerConfigs(): Promise<Record<string, SlateMcpServerConfig>> {
    return accountServerConfigs(this.accountConfig.current);
  }

  getServerUrlForIdentifier(identifier: string): Promise<string | undefined> {
    return serverUrlForIdentifier(this.accountConfig.current, this.accountConfig.lastKnown, identifier);
  }

  getDefinitions(): Promise<Array<{ identifier: string; serverConfig: SlateMcpServerConfig; source: "builtin" | "account" }>> {
    return serverDefinitions(this.accountConfig.current, this.includeBuiltins);
  }
}
