import { deleteDisabledToolsForServer, listServerTools, setServerCustomInstructions, toggleMcpToolDisabled } from "./mcp-tool-management.ts";
import {
  getMcpCustomInstructions,
  migrateCustomInstructions,
} from "./mcp-instructions-state.ts";
import type {
  McpInstructionUpdate,
  McpToolToggle,
  SlateMcpInstructionsAndTogglesDependencies,
} from "./mcp-instructions-contracts.ts";
import type { SlateMcpDisplayRow } from "./mcp-display-runtime.ts";

export type { McpSettingsPort, SlateMcpInstructionsAndTogglesDependencies } from "./mcp-instructions-contracts.ts";

export class SlateMcpInstructionsAndToggles {
  constructor(private readonly deps: SlateMcpInstructionsAndTogglesDependencies) {}

  migrateCustomInstructions(servers: readonly SlateMcpDisplayRow[]): void {
    migrateCustomInstructions(this.deps, servers);
  }

  setServerCustomInstructions(request: McpInstructionUpdate): Promise<unknown> {
    return setServerCustomInstructions(this.deps, request);
  }

  listServerTools(rawServerId: string): Promise<unknown[]> {
    return listServerTools(this.deps, rawServerId);
  }

  toggleMcpToolDisabled(request: McpToolToggle): Promise<unknown[]> {
    return toggleMcpToolDisabled(this.deps, request);
  }

  deleteDisabledToolsForServer(serverId: string): void {
    deleteDisabledToolsForServer(this.deps, serverId);
  }

  getMcpCustomInstructions(): Map<string, string> {
    return getMcpCustomInstructions(this.deps);
  }
}
