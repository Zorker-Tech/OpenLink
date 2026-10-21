/**
 * Watching a cloud agent until it finishes.
 *
 * A watch waits by polling the backend on the platform's own schedule, and answers with what happened: how the run
 * ended, which branch and pull request came out of it, what changed, and the agent's own summary. A run that was asked
 * to restart first waits for it to start again before its end counts; a rate-limited poll waits a little longer rather
 * than giving up, and one that fails unexpectedly is reported as what it is — the run carries on either way, and
 * whoever is waiting is told where to look when the wait itself runs out.
 */

import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts";
import { fetchSlateModelCatalog } from "./model-catalog-fetch.ts";
import type { CatalogModel } from "../../shared/agents/model-catalog.ts";

export const CLOUD_AGENT_MAX_WAIT_MS = 5 * 60 * 60_000;
export const CLOUD_AGENT_POLL_INTERVAL_MS = 10_000;
export const CLOUD_AGENT_POLL_RPC_TIMEOUT_MS = 30_000;
export const CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS = 60_000;
export const CLOUD_AGENT_RATE_LIMIT_JITTER_RATIO = 0.25;
export const CLOUD_AGENT_RUN_RESTART_GRACE_MS = 3 * 60_000;
export const SAVED_ENVIRONMENT_LIST_LIMIT = 500;
export const MAX_LISTED_SAVED_ENVIRONMENTS = 25;
export const MODEL_CATALOG_TTL_MS = 5 * 60_000;
export const TEAM_ADMIN_POLICY_TTL_MS = 5 * 60_000;
export const TEAM_ADMIN_POLICY_REQUEST_TIMEOUT_MS = 10_000;

export type CloudAgentRunStatus = "unspecified" | "creating" | "running" | "finished" | "error" | "expired" | number;

export interface DetailedComposer {
  readonly composer?: {
    readonly status?: CloudAgentRunStatus;
    readonly prUrl?: string;
    readonly branchName?: string;
    readonly commitCount?: number;
    readonly filesChanged?: number;
    readonly linesAdded?: number;
    readonly linesRemoved?: number;
  };
  readonly prs?: readonly { readonly prUrl?: string; readonly branchName?: string; readonly pullNumber?: number; readonly prStatus?: unknown }[];
  readonly summary?: string;
  readonly permanentError?: { readonly details?: { readonly title: string; readonly detail: string; readonly additionalInfo?: { readonly rateLimitReason?: string } } };
}

/** The wire's own vocabulary for how a run is doing, as the names this file uses. */
function statusName(status: CloudAgentRunStatus): CloudAgentRunStatus {
  if (typeof status === "string") return status;
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
      return "unspecified";
  }
}

/** How long to wait after a rate-limited poll: what it asked for, plus a little, so watchers do not all retry at once. */
export function cloudAgentRateLimitPauseMs(error: unknown, random: () => number = Math.random): number {
  const asked = typeof error === "object" && error != null && typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number" ? (error as { retryAfterMs: number }).retryAfterMs : CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS;
  return Math.round(asked + random() * asked * CLOUD_AGENT_RATE_LIMIT_JITTER_RATIO);
}

/** Where a caller can find the saved environments this account has, when the one it named is not among them. */
export function availableEnvironmentsNote(environments: readonly { name: string; publicId: string }[]): string {
  if (environments.length === 0) return " This account has no saved environments; create one from the Cloud Agents dashboard in Slate.";
  const listed = environments
    .slice(0, MAX_LISTED_SAVED_ENVIRONMENTS)
    .map((environment) => (environment.name.trim() ? `${environment.name.trim()} (${environment.publicId})` : environment.publicId))
    .join(", ");
  const hidden = environments.length - MAX_LISTED_SAVED_ENVIRONMENTS;
  return ` Available: ${listed}${hidden > 0 ? ` (+${hidden} more; set environment.id to launch one that isn't listed)` : ""}.`;
}

/** The platform's own message for an account that used up what its plan includes. */
export function resolveSlateLimitError(detailed: DetailedComposer | null | undefined): string | null {
  const details = detailed?.permanentError?.details;
  if (details?.additionalInfo?.rateLimitReason !== "slate_included_limit") return null;
  return [details.title, details.detail].map((value) => value.trim()).filter(Boolean).join("\n");
}

/** What a finished run changed, when it changed anything. */
export function formatDiffStats(detailed?: DetailedComposer): string | undefined {
  const composer = detailed?.composer;
  if (composer == null) return undefined;
  const parts: string[] = [];
  if ((composer.commitCount ?? 0) > 0) parts.push(`${composer.commitCount} commit${composer.commitCount === 1 ? "" : "s"}`);
  if ((composer.filesChanged ?? 0) > 0) parts.push(`+${composer.linesAdded ?? 0}/-${composer.linesRemoved ?? 0} across ${composer.filesChanged} file${composer.filesChanged === 1 ? "" : "s"}`);
  return parts.length > 0 ? `Changes: ${parts.join(", ")}.` : undefined;
}

/** What the caller who was watching is told: how it ended, and everything worth knowing about it. */
export function buildWatchResult(bcId: string, status: CloudAgentRunStatus, detailed?: DetailedComposer) {
  const normalized = statusName(status);
  const composer = detailed?.composer;
  const summary = detailed?.summary?.trim();
  const prUrl = (composer?.prUrl || detailed?.prs?.find((pr) => pr.prUrl)?.prUrl) ?? "";
  if (normalized === "error" || normalized === "expired") {
    const lines = [`The Slate agent (${bcId}) ${normalized === "expired" ? "expired" : "errored"} before finishing.`];
    const limit = resolveSlateLimitError(detailed);
    if (limit) lines.push("", limit);
    if (summary) lines.push("", summary);
    return { status: "error" as const, text: lines.join("\n") };
  }
  const lines = ["The Slate agent finished."];
  if (composer?.branchName) lines.push(`Branch: ${composer.branchName}`);
  lines.push(prUrl ? `Pull request: ${prUrl}` : "No pull request link is available yet (the agent may have made no changes, or the PR is still being created).");
  const stats = formatDiffStats(detailed);
  if (stats) lines.push(stats);
  if (summary) lines.push("", "Summary from the Slate agent:", summary);
  return { status: "completed" as const, text: lines.join("\n") };
}

export interface SavedEnvironment {
  readonly publicId: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface SavedEnvironmentClient {
  getEnvironment(request: { publicId: string }): Promise<{ environment?: SavedEnvironment }>;
  listEnvironments(request: { includeRepositoryScopeEnvironments: true; limit: number }): Promise<{ environments: readonly SavedEnvironment[] }>;
}

async function listSavedEnvironments(client: SavedEnvironmentClient): Promise<readonly SavedEnvironment[]> {
  return (await client.listEnvironments({ includeRepositoryScopeEnvironments: true, limit: SAVED_ENVIRONMENT_LIST_LIMIT })).environments;
}

/** The saved environment a launch named, by its id first and by its name next. */
export async function resolveSavedEnvironment(client: SavedEnvironmentClient, selector: { publicId?: string; name?: string }): Promise<SavedEnvironment> {
  const id = selector.publicId?.trim();
  const name = selector.name?.trim();
  if (id) {
    const value = (await client.getEnvironment({ publicId: id })).environment;
    if (value != null) return value;
    throw new SlateCloudAgentLaunchError(`No saved environment with id '${id}'.${availableEnvironmentsNote(await listSavedEnvironments(client))}`);
  }
  if (!name) throw new SlateCloudAgentLaunchError("A saved-environment launch requires the environment's public id or name.");
  const values = await listSavedEnvironments(client);
  const matches = values.filter((value) => value.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length === 1 && matches[0] != null) return matches[0];
  if (matches.length === 0) throw new SlateCloudAgentLaunchError(`No saved environment named '${name}'.${availableEnvironmentsNote(values)}`);
  // Two environments with one name are not a choice this launcher may make for the caller.
  throw new SlateCloudAgentLaunchError(`Multiple saved environments are named '${name}'. Set environment.id to one of: ${matches.map((value) => value.publicId).join(", ")}.`);
}

export interface Clock {
  monotonicNow(): number;
}

/** The model catalog, kept for a while so a launch does not ask for it every time. */
export class CloudAgentModelCatalogCache {
  private cache?: { catalog: readonly CatalogModel[]; fetchedAtMs: number };

  constructor(private readonly options: {
    readonly clock: Clock;
    readonly getCursorAccessToken: (options: { readonly backendUrl: string }) => Promise<string>;
    readonly getMachineId: () => Promise<string>;
    readonly onRequestId?: (requestId: string) => void;
    readonly modelCatalogForTesting?: readonly CatalogModel[];
  }) {}

  async listModels(): Promise<readonly CatalogModel[]> {
    if (this.options.modelCatalogForTesting != null) return this.options.modelCatalogForTesting;
    const now = this.options.clock.monotonicNow();
    if (this.cache != null && now - this.cache.fetchedAtMs < MODEL_CATALOG_TTL_MS) return this.cache.catalog;
    const catalog = await fetchSlateModelCatalog({
      getAccessToken: this.options.getCursorAccessToken,
      getMachineId: this.options.getMachineId,
      ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }),
    });
    this.cache = { catalog, fetchedAtMs: now };
    return catalog;
  }
}

/** Whether the team an account belongs to has turned cloud agents off, refreshed on its own clock. */
export class CloudAgentTeamAdminPolicyCache {
  private cache?: { disabled: boolean; fetchedAtMs: number };
  private fetch: Promise<void> | undefined;

  constructor(private readonly options: { readonly clock: Clock; readonly load: () => Promise<{ disableCloudAgentsInSand?: boolean }> }) {}

  isDisabledByTeamAdmin(): boolean {
    this.refresh();
    return this.cache?.disabled ?? false;
  }

  prefetchTeamAdminPolicy(): void {
    this.refresh();
  }

  private refresh(): void {
    // A policy that is still being read is not read again, and one that is fresh enough is not read at all.
    if (this.fetch != null) return;
    const now = this.options.clock.monotonicNow();
    if (this.cache != null && now - this.cache.fetchedAtMs < TEAM_ADMIN_POLICY_TTL_MS) return;
    this.fetch = this.options
      .load()
      .then((value) => {
        this.cache = { disabled: value.disableCloudAgentsInSand === true, fetchedAtMs: this.options.clock.monotonicNow() };
      })
      // A policy that could not be read leaves the last word standing rather than guessing.
      .catch(() => {
        this.cache = { disabled: this.cache?.disabled ?? false, fetchedAtMs: this.options.clock.monotonicNow() };
      })
      .finally(() => {
        this.fetch = undefined;
      });
  }
}

export interface PollingPolicy {
  start(run: () => void | Promise<void>): { dispose(): void };
}

export interface CloudAgentCompletion {
  readonly status: "completed" | "error";
  readonly text: string;
}

export class CloudAgentCompletionPoller {
  private readonly active = new Set<{ dispose(): void }>();

  constructor(
    private readonly options: {
      readonly completionPolling: PollingPolicy;
      readonly clock: Clock;
      readonly maxWaitMs?: number;
      readonly runRestartGraceMs?: number;
      readonly randomFn?: () => number;
      readonly isRateLimitError?: (error: unknown) => boolean;
    },
    private readonly getClient: () => {
      getBackgroundComposerInfo(request: { bcId: string; includeDiff: false; doNotThrowIfSetupNotFinished: true }, options: { timeoutMs: number }): Promise<{ composer?: DetailedComposer }>;
    },
  ) {}

  dispose(): void {
    for (const poll of this.active) poll.dispose();
    this.active.clear();
  }

  async awaitCompletion(bcId: string, options?: { waitForRestart?: boolean }): Promise<CloudAgentCompletion> {
    const client = this.getClient();
    const maxWaitMs = this.options.maxWaitMs ?? CLOUD_AGENT_MAX_WAIT_MS;
    const deadline = this.options.clock.monotonicNow() + maxWaitMs;
    const restartDeadline = this.options.clock.monotonicNow() + (this.options.runRestartGraceMs ?? CLOUD_AGENT_RUN_RESTART_GRACE_MS);
    let awaitingRestart = options?.waitForRestart ?? false;
    // The first tick only starts the schedule; the run has just been asked for.
    let skip = true;
    let pausedUntil = 0;
    return await new Promise<CloudAgentCompletion>((resolve) => {
      let settled = false;
      let poll: { dispose(): void } | undefined;
      const outOfTime = (): CloudAgentCompletion => ({
        status: "error",
        text: `The Slate agent (${bcId}) is still running after ${Math.round(maxWaitMs / 60_000)} minutes. It keeps running on the VM; check the Slate cloud agents dashboard for the result.`,
      });
      const finish = (value: CloudAgentCompletion): void => {
        if (settled) return;
        settled = true;
        poll?.dispose();
        if (poll != null) this.active.delete(poll);
        resolve(value);
      };
      poll = this.options.completionPolling.start(async () => {
        try {
          if (skip) {
            skip = false;
            return;
          }
          const now = this.options.clock.monotonicNow();
          // A poll that was told to wait out a rate limit keeps waiting, but not past the deadline.
          if (now < pausedUntil) {
            if (now >= deadline) finish(outOfTime());
            return;
          }
          let detailed: DetailedComposer | undefined;
          try {
            detailed = (await client.getBackgroundComposerInfo({ bcId, includeDiff: false, doNotThrowIfSetupNotFinished: true }, { timeoutMs: CLOUD_AGENT_POLL_RPC_TIMEOUT_MS })).composer;
          } catch (error) {
            if (this.options.isRateLimitError?.(error)) pausedUntil = now + cloudAgentRateLimitPauseMs(error, this.options.randomFn);
            if (now >= deadline) finish(outOfTime());
            return;
          }
          const status = statusName(detailed?.composer?.status ?? "unspecified");
          const active = status === "running" || status === "creating";
          if (awaitingRestart) {
            // A restart is over once the run moved again, or once waiting for it makes no sense any more.
            if (active || now >= restartDeadline) awaitingRestart = false;
            else {
              if (now >= deadline) finish(outOfTime());
              return;
            }
          }
          if (active || status === "unspecified") {
            if (now >= deadline) finish(outOfTime());
            return;
          }
          finish(buildWatchResult(bcId, status, detailed));
        } catch {
          finish({ status: "error", text: `The Slate agent (${bcId}) status check failed unexpectedly. Check the Slate cloud agents dashboard for the result.` });
        }
      });
      if (!settled) this.active.add(poll);
    });
  }
}
