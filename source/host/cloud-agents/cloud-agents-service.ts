/**
 * The cloud agents a host runs on someone else's machines.
 *
 * A launch is composed here and nowhere else: which repository the agent works on (the caller's, or the one a saved
 * environment is pinned to), the environment it runs in, the model and its parameters, and the message that starts it.
 * What comes back is what the backend said, read through the same small rules throughout — a run's status as one of
 * the five names, a pull request's state as the one this platform shows, and a diff as file changes a surface can
 * list. A launch a saved environment cannot satisfy is refused with what to change, and nothing is sent.
 */

import type { CatalogModel } from "../../shared/agents/model-catalog.ts";
import { createSlateCloudAgentClient, createSlateCloudAgentDashboardClient } from "../../adapters/interop/slate-backend/slate-cloud-agent-client-adapter.ts";
import type { CloudAgentEnvironment } from "./cloud-agent-request-composition.ts";
import {
  CloudAgentCompletionPoller,
  CloudAgentModelCatalogCache,
  CloudAgentTeamAdminPolicyCache,
} from "./cloud-agent-poll-loop.ts";
import {
  type CloudAgentClient,
  type DashboardClient,
  type SlateCloudAgentManagerOptions,
} from "./cloud-agent-manager-contracts.ts";
import {
  deleteCloudAgent,
  fetchCloudAgentFileChanges,
  fetchCloudAgentLivePrState,
  getCloudAgent,
  getCloudAgentInfo,
  getCloudAgentTranscriptDump,
  listCloudAgentArtifacts,
  listCloudAgents,
  pauseCloudAgent,
  renameCloudAgent,
  replyToCloudAgent,
  setCloudAgentArchived,
} from "./cloud-agent-manager-queries.ts";
import {
  launchCloudAgent,
  resolvePrivateWorkerTeamId,
  type CloudAgentLaunchRequest,
} from "./cloud-agent-manager-launch.ts";

export { CLOUD_AGENT_REQUEST_SOURCE, MAX_CLOUD_AGENT_FILES } from "./cloud-agent-manager-contracts.ts";
export type {
  CloudAgentClient,
  CloudAgentPrState,
  DashboardClient,
  SlateCloudAgentManagerOptions,
} from "./cloud-agent-manager-contracts.ts";
export {
  buildTranscriptJsonl,
  cloudAgentUrl,
  mapProtoPrStatus,
  mapRunStatus,
  normalizeDiffPath,
  resolveBranchName,
  resolvePr,
  resolvePrUrl,
  toFileChange,
} from "./cloud-agent-view-mappers.ts";

const TEAM_ADMIN_POLICY_TIMEOUT_MS = 10_000;
export class SlateCloudAgentManager {
  /** The agents this session started, watched or replied to. */
  readonly launchedIds = new Set<string>();
  private client?: CloudAgentClient;
  private dashboardClient?: DashboardClient;
  private readonly completionPoller: CloudAgentCompletionPoller;
  private readonly modelCatalog: CloudAgentModelCatalogCache;
  private readonly teamAdminPolicy: CloudAgentTeamAdminPolicyCache;

  constructor(private readonly options: SlateCloudAgentManagerOptions) {
    this.completionPoller = new CloudAgentCompletionPoller(options, () => this.getClient());
    this.modelCatalog = new CloudAgentModelCatalogCache(options);
    this.teamAdminPolicy = new CloudAgentTeamAdminPolicyCache({
      clock: options.clock,
      load: async () => (await this.getDashboardClient().getTeamAdminSettingsOrEmptyIfNotInTeam({}, { timeoutMs: TEAM_ADMIN_POLICY_TIMEOUT_MS })).backgroundAgentSettings ?? {},
    });
  }

  isDisabledByTeamAdmin(): boolean {
    return this.teamAdminPolicy.isDisabledByTeamAdmin();
  }

  prefetchTeamAdminPolicy(): void {
    this.teamAdminPolicy.prefetchTeamAdminPolicy();
  }

  dispose(): void {
    this.completionPoller.dispose();
  }

  listModels(): Promise<readonly CatalogModel[]> {
    return this.modelCatalog.listModels();
  }

  private getClient(): CloudAgentClient {
    return this.options.clientForTesting ?? (this.client ??= createSlateCloudAgentClient(this.options));
  }

  private getDashboardClient(): DashboardClient {
    return this.options.dashboardClientForTesting ?? (this.dashboardClient ??= createSlateCloudAgentDashboardClient(this.options));
  }

  /** The team a private worker belongs to: the one named, the only one this account has, or a question for the caller. */
  async resolvePrivateWorkerTeamId(environment?: CloudAgentEnvironment): Promise<number | undefined> {
    return resolvePrivateWorkerTeamId(environment, () => this.getDashboardClient());
  }

  async launch(args: CloudAgentLaunchRequest) {
    return launchCloudAgent(this.getClient(), () => this.getDashboardClient(), args);
  }

  awaitCompletion(agentId: string, options?: { waitForRestart?: boolean }) {
    return this.completionPoller.awaitCompletion(agentId, options);
  }

  async list(args?: { limit?: number; includeArchived?: boolean }) {
    return listCloudAgents(this.getClient(), args);
  }

  async get(agentId: string) {
    return getCloudAgent(this.getClient(), agentId);
  }

  async reply(args: { agentId: string; prompt: string; images?: readonly { data: Uint8Array; path?: string; mimeType?: string }[]; interrupt?: boolean; modelId?: string; modelParams?: Readonly<Record<string, string>> }) {
    return replyToCloudAgent(this.getClient(), args);
  }

  async cancel(agentId: string): Promise<void> {
    await pauseCloudAgent(this.getClient(), agentId);
  }

  async rename(agentId: string, newName: string): Promise<void> {
    await renameCloudAgent(this.getClient(), agentId, newName);
  }

  async setArchived(agentId: string, archived: boolean): Promise<void> {
    await setCloudAgentArchived(this.getClient(), agentId, archived);
  }

  async delete(agentId: string): Promise<void> {
    await deleteCloudAgent(this.getClient(), agentId);
  }

  async listArtifacts(agentId: string) {
    return listCloudAgentArtifacts(this.getClient(), agentId);
  }

  async getTranscriptDump(args: { agentId: string }) {
    return getCloudAgentTranscriptDump(this.getClient(), this.options.convertConversationMessagesToTrace, args.agentId);
  }

  async getInfo(agentId: string, includeFiles = true) {
    return getCloudAgentInfo(this.getClient(), agentId, includeFiles);
  }

  /** What the pull request says about itself now: a merged one is never asked again. */
  async fetchLivePrState(prUrl: string, storedState: string): Promise<string | null> {
    return fetchCloudAgentLivePrState(this.getClient(), prUrl, storedState);
  }

  /** The files a run changed, up to what a surface is told about. */
  async fetchFileChanges(agentId: string) {
    return fetchCloudAgentFileChanges(this.getClient(), agentId);
  }
}
