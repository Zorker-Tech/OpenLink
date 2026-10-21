/**
 * The cloud agents a host runs on someone else's machines.
 *
 * A launch is composed here and nowhere else: which repository the agent works on (the caller's, or the one a saved
 * environment is pinned to), the environment it runs in, the model and its parameters, and the message that starts it.
 * What comes back is what the backend said, read through the same small rules throughout — a run's status as one of
 * the five names, a pull request's state as the one this platform shows, and a diff as file changes a surface can
 * list. A launch a saved environment cannot satisfy is refused with what to change, and nothing is sent.
 */

import { randomUUID } from "node:crypto";
import { BackgroundComposerService } from "../../packages/proto/generated/aiserver/v1/background_composer_connect.ts";
import { DashboardService } from "../../packages/proto/generated/aiserver/v1/dashboard_connect.ts";
import type { CatalogModel } from "../../shared/agents/model-catalog.ts";
import { createSlateCursorBackendClient } from "../../shared/node/cursor-backend/cursor-inference.ts";
import { SLATE_WEBSITE_ORIGIN } from "../transcript/agent-run-error.ts";
import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";
import {
  buildCloudAgentConversationAction,
  buildCloudAgentRequestedModel,
  buildCloudAgentUserMessage,
  buildRepoFromRemote,
  resolveCloudAgentEnvironmentFields,
  resolveLaunchRepoReference,
  toStartRepoConfig,
  type CloudAgentEnvironment,
  type SavedEnvironment,
} from "./cloud-agent-request-composition.ts";
import {
  CloudAgentCompletionPoller,
  CloudAgentModelCatalogCache,
  CloudAgentTeamAdminPolicyCache,
  resolveSlateLimitError,
  resolveSavedEnvironment,
  type Clock,
  type DetailedComposer,
  type PollingPolicy,
  type SavedEnvironmentClient,
} from "./cloud-agent-poll-loop.ts";

/** How many file changes a surface is told about; a run that touched more is left at this. */
export const MAX_CLOUD_AGENT_FILES = 300;
/** The requester every request of this host says it is. */
export const CLOUD_AGENT_REQUEST_SOURCE = "slate";
const TEAM_ADMIN_POLICY_TIMEOUT_MS = 10_000;
const LIST_DEFAULT_LIMIT = 20;

type AnyRecord = Record<string, unknown>;

/** The run statuses this platform knows, as the names a surface shows. */
const RUN_STATUSES = ["creating", "running", "finished", "error", "expired"] as const;

export interface CloudAgentClient extends SavedEnvironmentClient {
  startBackgroundComposerFromSnapshot(request: AnyRecord): Promise<{ composer?: { bcId?: string } }>;
  getBackgroundComposerInfo(request: AnyRecord, options?: { timeoutMs: number }): Promise<{ composer?: DetailedComposer & { prompt?: { text?: string }; composer?: DetailedComposer["composer"] & { bcId?: string; name?: string; isArchived?: boolean; createdAtMs?: number; prStatus?: unknown }; prs?: readonly { prUrl?: string; branchName?: string; pullNumber?: number; prStatus?: unknown }[] } }>;
  listBackgroundComposers(request: { n: number }): Promise<{ composers: readonly AnyRecord[] }>;
  addAsyncFollowupBackgroundComposer(request: AnyRecord): Promise<{ runId?: string }>;
  pauseBackgroundComposer(request: AnyRecord): Promise<void>;
  renameBackgroundComposer(request: AnyRecord): Promise<void>;
  archiveBackgroundComposer(request: AnyRecord): Promise<void>;
  deleteBackgroundComposer(request: AnyRecord): Promise<void>;
  listBackgroundComposerArtifacts(request: AnyRecord): Promise<{ artifacts: readonly { absolutePath: string; sizeBytes: number | bigint }[] }>;
  getBackgroundComposerConversation(request: AnyRecord): Promise<{ conversation: unknown }>;
  getPullRequestMergeStatus(request: { prUrl: string }): Promise<{ isMerged?: boolean; isClosed?: boolean; isDraft?: boolean; state?: string }>;
  getOptimizedDiffDetails(request: AnyRecord): Promise<{ diff?: { diffs?: readonly { from: string; to: string; added: number; removed: number }[] } }>;
}

export interface DashboardClient {
  getTeamAdminSettingsOrEmptyIfNotInTeam(request: AnyRecord, options: { timeoutMs: number }): Promise<{ backgroundAgentSettings?: { disableCloudAgentsInSand?: boolean } }>;
  getTeams(request: { activeOnly: true }): Promise<{ teams: readonly { id: number; name: string; isDirectMember: boolean }[] }>;
}

/** How a run is doing, as the backend's own vocabulary or as one of the five names. */
export function mapRunStatus(status: unknown): string {
  if (typeof status === "string") {
    const value = status.toLowerCase();
    return (RUN_STATUSES as readonly string[]).includes(value) ? value : "unknown";
  }
  switch (status) {
    case 1:
      return "running";
    case 2:
      return "finished";
    case 3:
      return "error";
    case 4:
      return "creating";
    case 5:
      return "expired";
    default:
      return "unknown";
  }
}

export function resolvePrUrl(detailed?: DetailedComposer & { prs?: readonly { prUrl?: string }[] }): string {
  return detailed?.composer?.prUrl || detailed?.prs?.find((pr) => pr.prUrl)?.prUrl || "";
}

export function resolveBranchName(detailed?: DetailedComposer & { prs?: readonly { branchName?: string }[] }): string {
  return detailed?.composer?.branchName || detailed?.prs?.find((pr) => pr.branchName)?.branchName || "";
}

export type CloudAgentPrState = "none" | "unknown" | "open" | "draft" | "merged" | "closed";

export function mapProtoPrStatus(status: unknown): Exclude<CloudAgentPrState, "none" | "unknown"> | null {
  switch (status) {
    case 1:
      return "open";
    case 2:
      return "draft";
    case 3:
      return "merged";
    case 4:
      return "closed";
    default:
      return null;
  }
}

/** Which pull request a run's changes are in, and where it stands: the one it named first, the one that leads next. */
export function resolvePr(detailed?: DetailedComposer & { composer?: DetailedComposer["composer"] & { prStatus?: unknown } }): { state: CloudAgentPrState; number: number | null } {
  const url = resolvePrUrl(detailed);
  const primary = url.length > 0
    ? detailed?.prs?.find((pr) => pr.prUrl === url)
    : detailed?.prs?.find((pr) => pr.pullNumber != null || mapProtoPrStatus(pr.prStatus) != null);
  const state = mapProtoPrStatus(primary?.prStatus) ?? mapProtoPrStatus(detailed?.composer?.prStatus) ?? (url.length > 0 || primary != null ? "unknown" : "none");
  return { state, number: primary?.pullNumber ?? null };
}

/** A diff side that is `/dev/null` is the side that is not there. */
export function normalizeDiffPath(raw: string): string {
  const value = raw.trim();
  return value === "/dev/null" ? "" : value;
}

export function toFileChange(diff: { from: string; to: string; added: number; removed: number }) {
  const from = normalizeDiffPath(diff.from);
  const to = normalizeDiffPath(diff.to);
  const path = to || from;
  return path ? { path, added: diff.added, removed: diff.removed } : null;
}

/** Where a cloud agent is looked at, on this platform's own site. */
export function cloudAgentUrl(bcId: string): string {
  return `${SLATE_WEBSITE_ORIGIN}/cloud-agents/${bcId}`;
}

/** A conversation as the JSONL a box writes: one message per line, with counts that are too big written as text. */
export function buildTranscriptJsonl(conversation: unknown, convert: (conversation: unknown) => readonly unknown[]) {
  const lines = convert(conversation).map((message) => JSON.stringify(message, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  return { jsonl: lines.length > 0 ? `${lines.join("\n")}\n` : "", lineCount: lines.length };
}

export interface SlateCloudAgentManagerOptions {
  readonly getCursorAccessToken: (options?: { readonly backendUrl: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly completionPolling: PollingPolicy;
  readonly clock: Clock;
  readonly convertConversationMessagesToTrace: (conversation: unknown) => readonly unknown[];
  readonly clientForTesting?: CloudAgentClient;
  readonly dashboardClientForTesting?: DashboardClient;
  readonly modelCatalogForTesting?: readonly CatalogModel[];
  readonly onRequestId?: (id: string) => void;
}

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
    return this.options.clientForTesting ?? (this.client ??= createSlateCursorBackendClient(BackgroundComposerService, {
      getAccessToken: this.options.getCursorAccessToken,
      getMachineId: this.options.getMachineId,
      ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }),
    }) as unknown as CloudAgentClient);
  }

  private getDashboardClient(): DashboardClient {
    return this.options.dashboardClientForTesting ?? (this.dashboardClient ??= createSlateCursorBackendClient(DashboardService, {
      getAccessToken: this.options.getCursorAccessToken,
      getMachineId: this.options.getMachineId,
      ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }),
    }) as unknown as DashboardClient);
  }

  /** The team a private worker belongs to: the one named, the only one this account has, or a question for the caller. */
  async resolvePrivateWorkerTeamId(environment?: CloudAgentEnvironment): Promise<number | undefined> {
    if (environment == null || environment.type === "cloud" || environment.type === "environment") return undefined;
    if (environment.teamId != null) return environment.teamId;
    const teams = (await this.getDashboardClient().getTeams({ activeOnly: true })).teams.filter((team) => team.id > 0 && team.isDirectMember);
    if (teams.length === 1) return teams[0]?.id;
    if (teams.length === 0) {
      // A pool is shared with a team, so an account without one cannot have it.
      if (environment.type === "pool") throw new SlateCloudAgentLaunchError("A self-hosted pool requires an active team, but this account has none.");
      return undefined;
    }
    throw new SlateCloudAgentLaunchError(`This account has multiple active teams. Set environment.team_id to one of: ${teams.map((team) => `${team.name} (${team.id})`).join(", ")}.`);
  }

  async launch(args: { prompt: string; repoUrl?: string; startingRef?: string; environment?: CloudAgentEnvironment; modelId?: string; modelParams?: Readonly<Record<string, string>>; images?: readonly { data: Uint8Array; path?: string; mimeType?: string }[]; title?: string }) {
    // A named private worker checks out its own branch, so starting it from a ref is not something it can do.
    if (args.environment?.type === "machine" && args.startingRef?.trim()) {
      throw new SlateCloudAgentLaunchError(`A named private worker runs on its own checkout, so it can't start from '${args.startingRef}'. Omit starting_ref (the worker uses its current branch), or use a cloud or pool environment to start from a specific ref.`);
    }
    const saved = args.environment?.type === "environment"
      ? await resolveSavedEnvironment(this.getClient(), { ...(args.environment.publicId === undefined ? {} : { publicId: args.environment.publicId }), ...(args.environment.name === undefined ? {} : { name: args.environment.name }) }) as SavedEnvironment
      : undefined;
    const repo = buildRepoFromRemote(resolveLaunchRepoReference(args.repoUrl, saved), args.startingRef);
    const requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams);
    const bcId = `bc-${randomUUID()}`;
    const teamId = await this.resolvePrivateWorkerTeamId(args.environment);
    const request: AnyRecord = {
      bcId,
      snapshotNameOrId: repo.sanitizedRepoUrl,
      devcontainerStartingPoint: {
        url: repo.httpRepoUrl,
        ref: repo.baseBranch ?? "",
        ...(saved == null ? {} : { environmentPublicId: saved.publicId, ...(saved.name.trim() ? { environmentName: saved.name.trim() } : {}), repoConfig: toStartRepoConfig(saved.repoConfig) }),
      },
      snapshotWorkspaceRootPath: "/workspace",
      returnImmediately: true,
      repoUrl: repo.httpRepoUrl,
      source: CLOUD_AGENT_REQUEST_SOURCE,
      autoBranch: true,
      ...(repo.baseBranch === undefined ? {} : { baseBranch: repo.baseBranch }),
      autoCreatePr: true,
      conversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({ prompt: args.prompt, mode: "agent", ...(args.images === undefined ? {} : { images: args.images }) })),
      startingMessageType: "user-message",
      addInitialMessageToResponses: true,
      repositoryInfo: { pathEncryptionKey: "", shouldSyncIndex: false },
      ...resolveCloudAgentEnvironmentFields(repo.httpRepoUrl, args.environment),
      requestedModels: requestedModel == null ? [] : [requestedModel],
      skills: [],
      ...(teamId === undefined ? {} : { teamId }),
      ...(args.title?.trim() ? { name: args.title.trim() } : {}),
    };
    const response = await this.getClient().startBackgroundComposerFromSnapshot(request);
    // The backend may have named it; what it said is what the caller is told.
    const id = response.composer?.bcId || bcId;
    return { bcId: id, url: cloudAgentUrl(id) };
  }

  awaitCompletion(bcId: string, options?: { waitForRestart?: boolean }) {
    return this.completionPoller.awaitCompletion(bcId, options);
  }

  async list(args?: { limit?: number; includeArchived?: boolean }) {
    const response = await this.getClient().listBackgroundComposers({ n: args?.limit ?? LIST_DEFAULT_LIMIT });
    return response.composers
      // An archived run is left out unless the caller asked for it.
      .filter((composer) => (args?.includeArchived ?? false) || composer.isArchived !== true)
      .map((composer) => ({
        bcId: String(composer.bcId ?? ""),
        name: String(composer.name ?? ""),
        status: mapRunStatus(composer.status),
        branchName: String(composer.branchName ?? ""),
        prUrl: String(composer.prUrl ?? ""),
        isArchived: composer.isArchived === true,
        createdAtMs: Number(composer.createdAtMs ?? 0),
        url: cloudAgentUrl(String(composer.bcId ?? "")),
      }));
  }

  async get(bcId: string) {
    const id = bcId.trim();
    if (!id) return null;
    const detailed = (await this.getClient().getBackgroundComposerInfo({ bcId: id, includeDiff: false, doNotThrowIfSetupNotFinished: true })).composer;
    const composer = detailed?.composer;
    if (composer == null) return null;
    return {
      bcId: id,
      name: composer.name ?? "",
      status: mapRunStatus(composer.status),
      branchName: resolveBranchName(detailed),
      prUrl: resolvePrUrl(detailed),
      isArchived: composer.isArchived ?? false,
      createdAtMs: composer.createdAtMs ?? 0,
      url: cloudAgentUrl(id),
      filesChanged: composer.filesChanged ?? 0,
      linesAdded: composer.linesAdded ?? 0,
      linesRemoved: composer.linesRemoved ?? 0,
      // A run that stopped because the account used up what its plan includes says so.
      error: resolveSlateLimitError(detailed),
    };
  }

  async reply(args: { bcId: string; prompt: string; images?: readonly { data: Uint8Array; path?: string; mimeType?: string }[]; interrupt?: boolean; modelId?: string; modelParams?: Readonly<Record<string, string>> }) {
    const requestedModel = buildCloudAgentRequestedModel(args.modelId, args.modelParams);
    const response = await this.getClient().addAsyncFollowupBackgroundComposer({
      bcId: args.bcId,
      followupConversationAction: buildCloudAgentConversationAction(buildCloudAgentUserMessage({ prompt: args.prompt, ...(args.images === undefined ? {} : { images: args.images }) })),
      synchronous: args.interrupt ?? false,
      followupSource: CLOUD_AGENT_REQUEST_SOURCE,
      ...(requestedModel == null ? {} : { requestedModel }),
    });
    return { runId: response.runId };
  }

  async cancel(bcId: string): Promise<void> {
    await this.getClient().pauseBackgroundComposer({ bcId, source: CLOUD_AGENT_REQUEST_SOURCE });
  }

  async rename(bcId: string, newName: string): Promise<void> {
    await this.getClient().renameBackgroundComposer({ bcId, newName });
  }

  async setArchived(bcId: string, archived: boolean): Promise<void> {
    await this.getClient().archiveBackgroundComposer({ bcId, unarchive: !archived, source: CLOUD_AGENT_REQUEST_SOURCE });
  }

  async delete(bcId: string): Promise<void> {
    await this.getClient().deleteBackgroundComposer({ bcId });
  }

  async listArtifacts(bcId: string) {
    return (await this.getClient().listBackgroundComposerArtifacts({ bcId })).artifacts.map((artifact) => ({ path: artifact.absolutePath, sizeBytes: Number(artifact.sizeBytes) }));
  }

  async getTranscriptDump(args: { bcId: string }) {
    const bcId = args.bcId.trim();
    if (!bcId) return null;
    const response = await this.getClient().getBackgroundComposerConversation({ bcId });
    const dump = buildTranscriptJsonl(response.conversation, this.options.convertConversationMessagesToTrace);
    // The transcript is the answer; a status that could not be read leaves it at unknown rather than failing the dump.
    let status = "unknown";
    try {
      status = mapRunStatus((await this.getClient().getBackgroundComposerInfo({ bcId, includeDiff: false, doNotThrowIfSetupNotFinished: true })).composer?.composer?.status);
    } catch {}
    return { ...dump, status };
  }

  async getInfo(bcId: string, includeFiles = true) {
    const id = bcId.trim();
    if (!id) return null;
    let response: Awaited<ReturnType<CloudAgentClient["getBackgroundComposerInfo"]>>;
    try {
      response = await this.getClient().getBackgroundComposerInfo({ bcId: id, includeDiff: false, doNotThrowIfSetupNotFinished: true });
    } catch (error) {
      // A run that is not there (or not this account's) is not a failure to report, it is nothing to show.
      const candidate = error as { name?: unknown; code?: unknown };
      if (candidate?.name === "ConnectError" && (candidate.code === 5 || candidate.code === 7)) return null;
      throw error;
    }
    const detailed = response.composer;
    const composer = detailed?.composer;
    const filesChanged = composer?.filesChanged ?? 0;
    const pr = resolvePr(detailed);
    const prUrl = resolvePrUrl(detailed);
    const [files, livePrState] = await Promise.all([
      includeFiles && filesChanged > 0 ? this.fetchFileChanges(id) : Promise.resolve([]),
      this.fetchLivePrState(prUrl, pr.state),
    ]);
    return {
      bcId: id,
      status: mapRunStatus(composer?.status),
      name: composer?.name ?? "",
      prompt: detailed?.prompt?.text ?? "",
      branchName: resolveBranchName(detailed),
      prUrl,
      prState: livePrState ?? pr.state,
      prNumber: pr.number,
      filesChanged,
      linesAdded: composer?.linesAdded ?? 0,
      linesRemoved: composer?.linesRemoved ?? 0,
      files,
    };
  }

  /** What the pull request says about itself now: a merged one is never asked again. */
  async fetchLivePrState(prUrl: string, storedState: string): Promise<string | null> {
    if (!prUrl || storedState === "merged") return null;
    try {
      const value = await this.getClient().getPullRequestMergeStatus({ prUrl });
      if (value.isMerged) return "merged";
      if (value.isClosed) return "closed";
      if (value.isDraft) return "draft";
      if (value.state === "open") return "open";
      return null;
    } catch {
      return null;
    }
  }

  /** The files a run changed, up to what a surface is told about. */
  async fetchFileChanges(bcId: string) {
    try {
      const response = await this.getClient().getOptimizedDiffDetails({ bcId, excludeBeforeAfterDiffs: true });
      const changes: { path: string; added: number; removed: number }[] = [];
      for (const diff of response.diff?.diffs ?? []) {
        const change = toFileChange(diff);
        if (change != null) changes.push(change);
        if (changes.length >= MAX_CLOUD_AGENT_FILES) break;
      }
      return changes;
    } catch {
      return [];
    }
  }
}
