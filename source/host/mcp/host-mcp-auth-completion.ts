/**
 * An OAuth flow for an MCP connector finished somewhere else, and the host has to act on it.
 *
 * The servers are told the flow completed, any agent that was waiting for it is resumed in its transcript, and the
 * management side is restarted when there is one; the waiting agents themselves are kept in a registry that forgets
 * waits that outlived their time.
 */
import { McpAuthWaitRegistry } from "./mcp-auth-wait-registry.ts";
export interface HostMcpAuthCompletionEvent { readonly serverId: string; readonly serverName: string; readonly accountKey: string; readonly outcome: string; readonly requestingAgentId?: string }
export class HostMcpAuthCompletion { readonly waits: McpAuthWaitRegistry; constructor(readonly deps: { readonly getMcp: () => { noteAuthCompletedElsewhere(serverId: string, accountKey: string): string | null | undefined; management: { restart(): Promise<unknown> } }; readonly getTranscript: () => { resumeAfterMcpAuth(agentId: string, serverName: string, accountKey: string): Promise<unknown> } }, options?: { readonly waitRegistry?: McpAuthWaitRegistry }) { this.waits = options?.waitRegistry ?? new McpAuthWaitRegistry(); }
  registerConnectCard(event: Parameters<McpAuthWaitRegistry["register"]>[0]): void { this.waits.register(event); }
  resolve(completion: HostMcpAuthCompletionEvent): void { const waitingAgentId = this.waits.take(completion); const watchAgentId = this.deps.getMcp().noteAuthCompletedElsewhere(completion.serverId, completion.accountKey); if (completion.outcome === "cancelled") return; const agentId = completion.requestingAgentId ?? watchAgentId ?? waitingAgentId; if (agentId != null) void this.deps.getTranscript().resumeAfterMcpAuth(agentId, completion.serverName, completion.accountKey); }
  async resolveDesktop(completion: HostMcpAuthCompletionEvent): Promise<void> { try { await this.deps.getMcp().management.restart(); } catch {} this.resolve(completion); }
}
