import type { SlateMcpAccountDisplay, SlateMcpDisplayRow } from "./mcp-display-runtime.ts";
import type { SlateMcpDefinitionSource } from "./mcp-definition-source.ts";

export interface McpSettingsPort {
  migrateMcpCustomInstructionToServerId(args: { serverId: string; displayName: string }): void;
  setMcpCustomInstructionByServerId(args: { serverId: string; displayName: string; value: string; mirrorLegacyName: boolean }): void;
  getMcpDisabledToolsByServerId(): Record<string, string[]>;
  setMcpDisabledToolsByServerId(value: Record<string, string[]>): void;
  getMcpCustomInstructions(): Record<string, string>;
  getMcpCustomInstructionsByServerId(): Record<string, string>;
}

export interface SlateMcpInstructionsAndTogglesDependencies {
  settingsStore(): McpSettingsPort;
  resolveDisplayServer(id: string): Promise<SlateMcpDisplayRow | undefined>;
  listServers(): Promise<unknown>;
  lastAccountDisplayConfig(): SlateMcpAccountDisplay | null;
  getToolsRaw(): Promise<Array<{ providerIdentifier: string; toolName: string; title?: string; description?: string }>>;
  definitionSource?: SlateMcpDefinitionSource;
}

export type McpInstructionUpdate = { serverId: string; instructions: string };
export type McpToolToggle = { serverId: string; toolName: string };
