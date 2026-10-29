import { fetchSlateModelCatalog } from "./model-catalog-fetch.ts"
import type { CatalogModel } from "../../shared/agents/model-catalog.ts"
import { SlateCloudAgentLaunchError } from "./cloud-agent-launch-error.ts"

export const CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS = 60_000
export const CLOUD_AGENT_RATE_LIMIT_JITTER_RATIO = 0.25
export const SAVED_ENVIRONMENT_LIST_LIMIT = 500
export const MAX_LISTED_SAVED_ENVIRONMENTS = 25
export const MODEL_CATALOG_TTL_MS = 5 * 60_000
export const TEAM_ADMIN_POLICY_TTL_MS = 5 * 60_000
export const TEAM_ADMIN_POLICY_REQUEST_TIMEOUT_MS = 10_000

export type CloudAgentRunStatus = "unspecified" | "creating" | "running" | "finished" | "error" | "expired" | number

export interface DetailedComposer {
  readonly composer?: {
    readonly status?: CloudAgentRunStatus
    readonly prUrl?: string
    readonly branchName?: string
    readonly commitCount?: number
    readonly filesChanged?: number
    readonly linesAdded?: number
    readonly linesRemoved?: number
  }
  readonly prs?: readonly { readonly prUrl?: string; readonly branchName?: string; readonly pullNumber?: number; readonly prStatus?: unknown }[]
  readonly summary?: string
  readonly permanentError?: { readonly details?: { readonly title: string; readonly detail: string; readonly additionalInfo?: { readonly rateLimitReason?: string } } }
}

export interface SavedEnvironment {
  readonly publicId: string
  readonly name: string
  readonly [key: string]: unknown
}

export interface SavedEnvironmentClient {
  getEnvironment(request: { publicId: string }): Promise<{ environment?: SavedEnvironment }>
  listEnvironments(request: { includeRepositoryScopeEnvironments: true; limit: number }): Promise<{ environments: readonly SavedEnvironment[] }>
}

export interface Clock {
  monotonicNow(): number
}

export function normalizeCloudAgentRunStatus(status: CloudAgentRunStatus): CloudAgentRunStatus {
  if (typeof status === "string") return status
  switch (status) {
    case 1: return "running"
    case 2: return "finished"
    case 3: return "error"
    case 4: return "creating"
    case 5: return "expired"
    default: return "unspecified"
  }
}

export function cloudAgentRateLimitPauseMs(error: unknown, random: () => number = Math.random): number {
  const retryAfter = typeof error === "object" && error !== null &&
    typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
    ? (error as { retryAfterMs: number }).retryAfterMs
    : CLOUD_AGENT_RATE_LIMIT_FALLBACK_MS
  return Math.round(retryAfter + random() * retryAfter * CLOUD_AGENT_RATE_LIMIT_JITTER_RATIO)
}

export function availableEnvironmentsNote(environments: readonly SavedEnvironment[]): string {
  if (environments.length === 0) {
    return " This account has no saved environments; create one from the Cloud Agents dashboard in Slate."
  }
  const listed = environments
    .slice(0, MAX_LISTED_SAVED_ENVIRONMENTS)
    .map(({ name, publicId }) => (name.trim() ? `${name.trim()} (${publicId})` : publicId))
    .join(", ")
  const hidden = environments.length - MAX_LISTED_SAVED_ENVIRONMENTS
  return ` Available: ${listed}${hidden > 0 ? ` (+${hidden} more; set environment.id to launch one that isn't listed)` : ""}.`
}

export function resolveSlateLimitError(detailed: DetailedComposer | null | undefined): string | null {
  const details = detailed?.permanentError?.details
  if (details?.additionalInfo?.rateLimitReason !== "slate_included_limit") return null
  return [details.title, details.detail].map(value => value.trim()).filter(Boolean).join("\n")
}

export function formatDiffStats(detailed?: DetailedComposer): string | undefined {
  const composer = detailed?.composer
  if (composer === undefined) return undefined
  const summary: string[] = []
  if ((composer.commitCount ?? 0) > 0) {
    summary.push(`${composer.commitCount} commit${composer.commitCount === 1 ? "" : "s"}`)
  }
  if ((composer.filesChanged ?? 0) > 0) {
    summary.push(`+${composer.linesAdded ?? 0}/-${composer.linesRemoved ?? 0} across ${composer.filesChanged} file${composer.filesChanged === 1 ? "" : "s"}`)
  }
  return summary.length === 0 ? undefined : `Changes: ${summary.join(", ")}.`
}

export function buildWatchResult(bcId: string, status: CloudAgentRunStatus, detailed?: DetailedComposer) {
  const normalized = normalizeCloudAgentRunStatus(status)
  const composer = detailed?.composer
  const summary = detailed?.summary?.trim()
  const prUrl = composer?.prUrl || detailed?.prs?.find(pr => pr.prUrl)?.prUrl || ""

  if (normalized === "error" || normalized === "expired") {
    const lines = [`The Slate agent (${bcId}) ${normalized === "expired" ? "expired" : "errored"} before finishing.`]
    const limit = resolveSlateLimitError(detailed)
    if (limit !== null) lines.push("", limit)
    if (summary) lines.push("", summary)
    return { status: "error" as const, text: lines.join("\n") }
  }

  const lines = ["The Slate agent finished."]
  if (composer?.branchName) lines.push(`Branch: ${composer.branchName}`)
  lines.push(prUrl ? `Pull request: ${prUrl}` : "No pull request link is available yet (the agent may have made no changes, or the PR is still being created).")
  const stats = formatDiffStats(detailed)
  if (stats) lines.push(stats)
  if (summary) lines.push("", "Summary from the Slate agent:", summary)
  return { status: "completed" as const, text: lines.join("\n") }
}

async function listSavedEnvironments(client: SavedEnvironmentClient): Promise<readonly SavedEnvironment[]> {
  return (await client.listEnvironments({ includeRepositoryScopeEnvironments: true, limit: SAVED_ENVIRONMENT_LIST_LIMIT })).environments
}

export async function resolveSavedEnvironment(
  client: SavedEnvironmentClient,
  selector: { publicId?: string; name?: string },
): Promise<SavedEnvironment> {
  const id = selector.publicId?.trim()
  const name = selector.name?.trim()
  if (id) {
    const environment = (await client.getEnvironment({ publicId: id })).environment
    if (environment !== undefined) return environment
    throw new SlateCloudAgentLaunchError(`No saved environment with id '${id}'.${availableEnvironmentsNote(await listSavedEnvironments(client))}`)
  }
  if (!name) throw new SlateCloudAgentLaunchError("A saved-environment launch requires the environment's public id or name.")

  const environments = await listSavedEnvironments(client)
  const matches = environments.filter(environment => environment.name.trim().toLowerCase() === name.toLowerCase())
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new SlateCloudAgentLaunchError(`No saved environment named '${name}'.${availableEnvironmentsNote(environments)}`)
  throw new SlateCloudAgentLaunchError(`Multiple saved environments are named '${name}'. Set environment.id to one of: ${matches.map(value => value.publicId).join(", ")}.`)
}

export class CloudAgentModelCatalogCache {
  private cache?: { catalog: readonly CatalogModel[]; fetchedAtMs: number }

  constructor(private readonly options: {
    readonly clock: Clock
    readonly getCursorAccessToken: (options: { readonly backendUrl: string }) => Promise<string>
    readonly getMachineId: () => Promise<string>
    readonly onRequestId?: (requestId: string) => void
    readonly modelCatalogForTesting?: readonly CatalogModel[]
  }) {}

  async listModels(): Promise<readonly CatalogModel[]> {
    if (this.options.modelCatalogForTesting !== undefined) return this.options.modelCatalogForTesting
    const now = this.options.clock.monotonicNow()
    if (this.cache !== undefined && now - this.cache.fetchedAtMs < MODEL_CATALOG_TTL_MS) return this.cache.catalog
    const catalog = await fetchSlateModelCatalog({
      getAccessToken: this.options.getCursorAccessToken,
      getMachineId: this.options.getMachineId,
      ...(this.options.onRequestId === undefined ? {} : { onRequestId: this.options.onRequestId }),
    })
    this.cache = { catalog, fetchedAtMs: now }
    return catalog
  }
}

export class CloudAgentTeamAdminPolicyCache {
  private cache?: { disabled: boolean; fetchedAtMs: number }
  private fetch: Promise<void> | undefined

  constructor(private readonly options: {
    readonly clock: Clock
    readonly load: () => Promise<{ disableCloudAgentsInSand?: boolean }>
  }) {}

  isDisabledByTeamAdmin(): boolean {
    this.refresh()
    return this.cache?.disabled ?? false
  }

  prefetchTeamAdminPolicy(): void {
    this.refresh()
  }

  private refresh(): void {
    if (this.fetch !== undefined) return
    const now = this.options.clock.monotonicNow()
    if (this.cache !== undefined && now - this.cache.fetchedAtMs < TEAM_ADMIN_POLICY_TTL_MS) return
    this.fetch = this.options.load()
      .then(value => {
        this.cache = { disabled: value.disableCloudAgentsInSand === true, fetchedAtMs: this.options.clock.monotonicNow() }
      })
      .catch(() => {
        this.cache = { disabled: this.cache?.disabled ?? false, fetchedAtMs: this.options.clock.monotonicNow() }
      })
      .finally(() => {
        this.fetch = undefined
      })
  }
}
