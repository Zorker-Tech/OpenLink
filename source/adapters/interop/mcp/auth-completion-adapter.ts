/**
 * An OAuth flow for an MCP connector finished somewhere else, and the host has to act on it.
 *
 * The servers are told the flow completed, any agent that was waiting for it is resumed in its transcript, and the
 * management side is restarted when there is one; the waiting agents themselves are kept in a registry that forgets
 * waits that outlived their time.
 */
import { McpAuthWaitRegistry } from "../../../host/mcp/mcp-auth-wait-registry.ts";
export interface HostMcpAuthCompletionEvent { readonly serverId: string; readonly serverName: string; readonly accountKey: string; readonly outcome: string; readonly requestingAgentId?: string }
interface AuthCompletionDependencies {
  readonly getMcp: () => {
    noteAuthCompletedElsewhere(serverId: string, accountKey: string): string | null | undefined;
    management: { restart(): Promise<unknown> };
  };
  readonly getTranscript: () => {
    resumeAfterMcpAuth(agentId: string, serverName: string, accountKey: string): Promise<unknown>;
  };
}

interface CompletionOptions {
  readonly waitRegistry?: McpAuthWaitRegistry;
}

const CANCELLED_AUTH_OUTCOME = "cancelled";

function selectResumeTarget(
  completion: HostMcpAuthCompletionEvent,
  observerTarget: string | null | undefined,
  pendingTarget: string | null,
): string | null | undefined {
  if (completion.outcome === CANCELLED_AUTH_OUTCOME) return undefined;
  if (completion.requestingAgentId !== null && completion.requestingAgentId !== undefined) {
    return completion.requestingAgentId;
  }
  if (observerTarget !== null && observerTarget !== undefined) return observerTarget;
  return pendingTarget;
}

async function restartManagementBestEffort(restart: () => Promise<unknown>): Promise<void> {
  try {
    await restart();
  } catch {
    // The auth result can still resume its waiting agent.
  }
}

function resumeWaitingAgent(
  dependencies: AuthCompletionDependencies,
  completion: HostMcpAuthCompletionEvent,
  agentId: string | null | undefined,
): void {
  if (agentId == null) return;
  void dependencies.getTranscript().resumeAfterMcpAuth(
    agentId,
    completion.serverName,
    completion.accountKey,
  );
}

export class HostMcpAuthCompletion {
  readonly waits: McpAuthWaitRegistry;

  constructor(
    readonly deps: AuthCompletionDependencies,
    options?: CompletionOptions,
  ) {
    this.waits = options?.waitRegistry ?? new McpAuthWaitRegistry();
  }

  registerConnectCard(event: Parameters<McpAuthWaitRegistry["register"]>[0]): void {
    this.waits.register(event);
  }

  resolve(completion: HostMcpAuthCompletionEvent): void {
    const pendingTarget = this.waits.take(completion);
    const observerTarget = this.deps.getMcp().noteAuthCompletedElsewhere(
      completion.serverId,
      completion.accountKey,
    );
    const resumeTarget = selectResumeTarget(completion, observerTarget, pendingTarget);
    resumeWaitingAgent(this.deps, completion, resumeTarget);
  }

  async resolveDesktop(completion: HostMcpAuthCompletionEvent): Promise<void> {
    await restartManagementBestEffort(() => this.deps.getMcp().management.restart());
    this.resolve(completion);
  }
}
