import { resolveMcpCustomInstruction } from "../../mcp-custom-instructions.ts";
import { type SlateMcpDisplayRow } from "./mcp-display-runtime.ts";
import type { SlateMcpInstructionsAndTogglesDependencies } from "./mcp-instructions-contracts.ts";

export function migrateCustomInstructions(
  deps: SlateMcpInstructionsAndTogglesDependencies,
  servers: readonly SlateMcpDisplayRow[],
): void {
  for (const server of servers) {
    if (server.id !== "0") {
      deps.settingsStore().migrateMcpCustomInstructionToServerId({ serverId: server.id, displayName: server.name });
    }
  }
}

export function getMcpCustomInstructions(
  deps: SlateMcpInstructionsAndTogglesDependencies,
): Map<string, string> {
  const legacy = deps.settingsStore().getMcpCustomInstructions();
  const byServerId = deps.settingsStore().getMcpCustomInstructionsByServerId();
  const instructions = new Map(Object.entries(legacy));

  for (const server of deps.lastAccountDisplayConfig()?.servers ?? []) {
    if (server.serverIdentifier == null) continue;
    const instruction = resolveMcpCustomInstruction(server.name, byServerId[server.id] ?? legacy[server.name]);
    instructions.set(server.serverIdentifier, instruction);
    for (const account of server.accounts ?? []) {
      if (account.serverIdentifier != null) instructions.set(account.serverIdentifier, instruction);
    }
  }
  return instructions;
}
