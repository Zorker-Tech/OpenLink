import { provisionalMcpAccountServerIdentifier } from "../../mcp.ts";
import { projectAccountRuntimeConfig } from "./mcp-account-display-policy.ts";
import type { SlateMcpAccountDisplay } from "./mcp-display-contracts.ts";
import type { AccountSlotAccounts, McpAccountSlotLifecycleDependencies } from "./mcp-account-slot-contracts.ts";

export function commitAccountSlotChange(
  dependencies: McpAccountSlotLifecycleDependencies,
  serverId: string,
  patchAccounts: (accounts: AccountSlotAccounts) => AccountSlotAccounts,
  patchSummaries: (summaries: any[], rowIdentifier: string) => any[],
): unknown | null {
  const currentDisplay = dependencies.lastAccountDisplayConfig();
  const currentState = dependencies.lastListedState() as { servers?: any[]; [key: string]: unknown } | null;
  if (currentDisplay == null || currentState == null) return null;

  const currentRow = currentDisplay.servers.find((server) => server.id === serverId);
  if (currentRow == null) return null;
  const rowIdentifier = currentRow.serverIdentifier ?? `mcp-row-${currentRow.id}`;
  const updatedAccounts = patchAccounts(currentRow.accounts ?? []);
  if (updatedAccounts.length === 0) return null;

  const updatedDisplay: SlateMcpAccountDisplay = {
    ...currentDisplay,
    servers: currentDisplay.servers.map((server) => server.id === serverId ? { ...server, accounts: updatedAccounts } : server),
  };
  dependencies.setLastAccountDisplayConfig(updatedDisplay);
  dependencies.definitionSource.adoptAccountConfig(projectAccountRuntimeConfig(updatedDisplay));
  dependencies.invalidateToolsCache();
  dependencies.resetPushState();

  const updatedState = {
    ...currentState,
    servers: patchSummaries(currentState.servers as any[], rowIdentifier),
  };
  dependencies.setLastListedState(updatedState);
  return updatedState;
}

export function accountSlotSummaryIdentifier(rowIdentifier: string, accountKey: string): string {
  return provisionalMcpAccountServerIdentifier(rowIdentifier, accountKey);
}
