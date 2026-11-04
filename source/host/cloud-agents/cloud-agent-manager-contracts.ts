import type { CatalogModel } from "../../shared/agents/model-catalog.ts";
import type {
  Clock,
  DetailedComposer,
  PollingPolicy,
  SavedEnvironmentClient,
} from "./cloud-agent-poll-loop.ts";

export const MAX_CLOUD_AGENT_FILES = 300;
export const CLOUD_AGENT_REQUEST_SOURCE = "slate";

export interface CloudAgentClient extends SavedEnvironmentClient {
  startBackgroundComposerFromSnapshot(request: Record<string, unknown>): Promise<{ composer?: { bcId?: string } }>;
  getBackgroundComposerInfo(request: Record<string, unknown>, options?: { timeoutMs: number }): Promise<{
    composer?: DetailedComposer & {
      prompt?: { text?: string };
      composer?: DetailedComposer["composer"] & {
        bcId?: string;
        name?: string;
        isArchived?: boolean;
        createdAtMs?: number;
        prStatus?: unknown;
      };
      prs?: readonly { prUrl?: string; branchName?: string; pullNumber?: number; prStatus?: unknown }[];
    };
  }>;
  listBackgroundComposers(request: { n: number }): Promise<{ composers: readonly Record<string, unknown>[] }>;
  addAsyncFollowupBackgroundComposer(request: Record<string, unknown>): Promise<{ runId?: string }>;
  pauseBackgroundComposer(request: Record<string, unknown>): Promise<void>;
  renameBackgroundComposer(request: Record<string, unknown>): Promise<void>;
  archiveBackgroundComposer(request: Record<string, unknown>): Promise<void>;
  deleteBackgroundComposer(request: Record<string, unknown>): Promise<void>;
  listBackgroundComposerArtifacts(request: Record<string, unknown>): Promise<{
    artifacts: readonly { absolutePath: string; sizeBytes: number | bigint }[];
  }>;
  getBackgroundComposerConversation(request: Record<string, unknown>): Promise<{ conversation: unknown }>;
  getPullRequestMergeStatus(request: { prUrl: string }): Promise<{
    isMerged?: boolean;
    isClosed?: boolean;
    isDraft?: boolean;
    state?: string;
  }>;
  getOptimizedDiffDetails(request: Record<string, unknown>): Promise<{
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
