import { normalizeAccountLabel } from "./mcp-account-display-policy.ts";
import { parseInt32McpServerId } from "./mcp-server-id.ts";
import { commitAccountSlotChange, accountSlotSummaryIdentifier } from "./mcp-account-slot-commit.ts";
import { resolveOAuthAccountServer } from "./mcp-account-slot-resolution.ts";
import type { McpAccountSlotLifecycleDependencies } from "./mcp-account-slot-contracts.ts";

export class SlateMcpAccountSlotLifecycle {
  constructor(private readonly dependencies: McpAccountSlotLifecycleDependencies) {}

  async logoutAccount(id: string, rawAccountKey: string): Promise<unknown> {
    const accountKey = normalizeAccountLabel(rawAccountKey);
    const { serverId, serverUrl } = await resolveOAuthAccountServer(this.dependencies, id);
    await this.dependencies.backendMcpExec.logoutAccount({ serverUrl, accountKey });
    this.dependencies.clearPendingAuthWatch(serverId, accountKey);
    return this.dependencies.reloadServers();
  }

  async renameAccount(id: string, rawAccountKey: string, rawNewAccountKey: string): Promise<unknown> {
    const accountKey = normalizeAccountLabel(rawAccountKey);
    const newAccountKey = normalizeAccountLabel(rawNewAccountKey);
    const { serverId } = await resolveOAuthAccountServer(this.dependencies, id);
    await this.dependencies.backendMcpExec.renameAccount({
      serverId: parseInt32McpServerId(serverId),
      accountKey,
      newAccountKey,
    });
    const pendingWatch = this.dependencies.clearPendingAuthWatch(serverId, accountKey);
    if (pendingWatch != null) this.dependencies.notifyWatchCancelled(pendingWatch);

    const updated = commitAccountSlotChange(
      this.dependencies,
      serverId,
      (slots) => slots.map((slot) => slot.accountKey === accountKey
        ? { accountKey: newAccountKey, hasToken: slot.hasToken }
        : slot),
      (summaries, rowIdentifier) => summaries.map((summary: any) =>
        summary.id === serverId && summary.accountKey === accountKey
          ? { ...summary, accountKey: newAccountKey, serverIdentifier: accountSlotSummaryIdentifier(rowIdentifier, newAccountKey) }
          : summary),
    );
    return updated ?? this.dependencies.reloadServers();
  }

  async removeAccount(id: string, rawAccountKey: string): Promise<unknown> {
    const accountKey = normalizeAccountLabel(rawAccountKey);
    const { serverId } = await resolveOAuthAccountServer(this.dependencies, id);
    await this.dependencies.backendMcpExec.deleteAccount({ serverId: parseInt32McpServerId(serverId), accountKey });
    const pendingWatch = this.dependencies.clearPendingAuthWatch(serverId, accountKey);
    if (pendingWatch != null) this.dependencies.notifyWatchCancelled(pendingWatch);

    const updated = commitAccountSlotChange(
      this.dependencies,
      serverId,
      (slots) => slots.filter((slot) => slot.accountKey !== accountKey),
      (summaries) => summaries.filter((summary: any) => !(summary.id === serverId && summary.accountKey === accountKey)),
    );
    return updated ?? this.dependencies.reloadServers();
  }
}
