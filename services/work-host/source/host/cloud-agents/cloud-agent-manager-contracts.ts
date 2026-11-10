import type { CatalogModel } from "../../shared/agents/model-catalog.ts";
import type {
  Clock,
  DetailedCloudAgent,
  PollingPolicy,
  SavedEnvironmentClient,
} from "./cloud-agent-poll-loop.ts";

export const MAX_CLOUD_AGENT_FILES = 300;
export const CLOUD_AGENT_REQUEST_SOURCE = "slate";

export interface CloudAgentClient extends SavedEnvironmentClient {
  launch(request: Record<string, unknown>): Promise<{ agent?: { agentId?: string } }>;
  get(request: Record<string, unknown>, options?: { timeoutMs: number }): Promise<{
    agent?: DetailedCloudAgent & { prompt?: { text?: string } };
  }>;
  list(request: { n: number }): Promise<{ agents: readonly Record<string, unknown>[] }>;
  reply(request: Record<string, unknown>): Promise<{ runId?: string }>;
  pause(request: Record<string, unknown>): Promise<void>;
  rename(request: Record<string, unknown>): Promise<void>;
  archive(request: Record<string, unknown>): Promise<void>;
  delete(request: Record<string, unknown>): Promise<void>;
  listArtifacts(request: Record<string, unknown>): Promise<{
    artifacts: readonly { absolutePath: string; sizeBytes: number | bigint }[];
  }>;
  getConversation(request: Record<string, unknown>): Promise<{ conversation: unknown }>;
  getPullRequestMergeStatus(request: { prUrl: string }): Promise<{
    isMerged?: boolean;
    isClosed?: boolean;
    isDraft?: boolean;
    state?: string;
  }>;
  getDiffDetails(request: Record<string, unknown>): Promise<{
    diff?: { diffs?: readonly { from: string; to: string; added: number; removed: number }[] };
  }>;
}

export interface DashboardClient {
  getTeamAdminSettingsOrEmptyIfNotInTeam(
    request: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<{ backgroundAgentSettings?: { disableCloudAgentsInSand?: boolean } }>;
  getTeams(request: { activeOnly: true }): Promise<{
    teams: readonly { id: number; name: string; isDirectMember: boolean }[];
  }>;
}

export type CloudAgentPrState = "none" | "unknown" | "open" | "draft" | "merged" | "closed";

export interface SlateCloudAgentManagerOptions {
  readonly getAccessToken: (options?: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly completionPolling: PollingPolicy;
  readonly clock: Clock;
  readonly convertConversationMessagesToTrace: (conversation: unknown) => readonly unknown[];
  readonly clientForTesting?: CloudAgentClient;
  readonly dashboardClientForTesting?: DashboardClient;
  readonly modelCatalogForTesting?: readonly CatalogModel[];
  readonly onRequestId?: (id: string) => void;
}
