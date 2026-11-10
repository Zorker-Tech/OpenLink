/** Progress, dashboard outcomes and safe failure summaries for a box restore. */

import { renameSync, writeFileSync } from "node:fs"
import type { CopyInResult } from "./copy-in-contracts.ts"
import { INCOMPLETE_LEGACY_HYDRATE_REASON } from "./box-store-hydration.ts"

export const BOX_COPY_IN_EXIT_NOOP = 0
export const BOX_COPY_IN_EXIT_FAILED = 1
export const BOX_COPY_IN_EXIT_HYDRATED = 10
export const SLATE_BOX_COPY_IN_STATUS_PATH = "/tmp/slate-copy-in-status.json"
export const COPY_IN_STATUS_THROTTLE_MS = 750
export const COPY_IN_HYDRATE_ATTEMPTS = 8
export const COPY_IN_STUCK_THRESHOLD_MS = 5 * 60_000

export interface CopyInTraceStatus {
  readonly copyStage?: "manifest" | "symlink"
  readonly fileEntries?: number
  readonly symlinkEntries?: number
  readonly symlinksStarted?: number
  readonly symlinksCompleted?: number
  readonly symlinksInFlight?: number
  readonly activeSymlinkSteps?: Readonly<Record<string, number>>
}

function positiveEnvironmentInteger(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim()
  if (raw == null || raw.length === 0) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function resolveCopyInConcurrency(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveEnvironmentInteger(env, "SLATE_BOX_STORE_COPY_IN_CONCURRENCY")
}

export function resolveCopyInAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnvironmentInteger(env, "SLATE_BOX_COPY_IN_ATTEMPTS") ?? COPY_IN_HYDRATE_ATTEMPTS
}

export function resolveCopyInStuckThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveEnvironmentInteger(env, "SLATE_BOX_COPY_IN_STUCK_MS") ?? COPY_IN_STUCK_THRESHOLD_MS
}

export function classifyCopyInMeteredOutcome(result: CopyInResult): "hydrated" | "empty" | "partial" | "failed" {
  switch (result.outcome) {
    case "hydrated": return "hydrated"
    case "noop": return "empty"
    case "failed":
      return result.message.startsWith("partial hydrate") || result.message.startsWith(INCOMPLETE_LEGACY_HYDRATE_REASON)
        ? "partial"
        : "failed"
  }
}

export function buildCopyInStatusFromResult(result: CopyInResult): Record<string, unknown> {
  const state = result.outcome === "failed" ? "failed" : "done"
  return {
    phase: state,
    restored: result.restoredFiles,
    total: result.indexedEntries,
    bytes: result.restoredBytes,
    outcome: classifyCopyInMeteredOutcome(result),
    storeDbEntries: result.storeDatabases,
  }
}

/** A throttled, atomic snapshot for the desktop's progress panel. */
export function makeCopyInStatusWriter(
  path = SLATE_BOX_COPY_IN_STATUS_PATH,
  now: () => number = Date.now,
): (status: unknown, options?: { force?: boolean }) => void {
  let lastSavedAt = 0
  return (status, options) => {
    const timestamp = now()
    if (options?.force !== true && timestamp - lastSavedAt < COPY_IN_STATUS_THROTTLE_MS) return
    lastSavedAt = timestamp
    try {
      const scratch = `${path}.tmp`
      writeFileSync(scratch, JSON.stringify(status))
      renameSync(scratch, path)
    } catch {
      // A dashboard snapshot is advisory; storage failures do not change restore outcome.
    }
  }
}

/** What the watchdog records when a restore advances slowly or stops advancing. */
export function buildCopyInWatchdogEvent(input: {
  readonly progressedSinceLastTick: boolean
  readonly progress: { readonly total: number; readonly files: number; readonly bytes: number }
  readonly elapsedMs: number
  readonly thresholdMs: number
  readonly trace?: CopyInTraceStatus
}): { level: "info" | "warn"; metadata: Record<string, string> } {
  const advancing = input.progressedSinceLastTick
  const metadata: Record<string, string> = {
    outcome: advancing ? "slow" : "stuck",
    reason: advancing ? "moving-data-in-slow-but-advancing" : "moving-data-in-exceeded-threshold",
    manifest_entries: String(input.progress.total),
    files: String(input.progress.files),
    bytes: String(input.progress.bytes),
    duration_ms: String(input.elapsedMs),
    threshold_ms: String(input.thresholdMs),
  }

  const traceFields = [
    ["stage", input.trace?.copyStage],
    ["file_entries", input.trace?.fileEntries],
    ["symlink_entries", input.trace?.symlinkEntries],
    ["symlinks_started", input.trace?.symlinksStarted],
    ["symlinks_completed", input.trace?.symlinksCompleted],
    ["symlinks_in_flight", input.trace?.symlinksInFlight],
  ] as const
  for (const [key, value] of traceFields) {
    if (value !== undefined) metadata[key] = String(value)
  }

  const active = Object.entries(input.trace?.activeSymlinkSteps ?? {})
    .filter(([, count]) => count > 0)
    .map(([step, count]) => `${step}:${count}`)
    .join(",")
  if (active.length > 0) metadata.active_symlink_steps = active
  return { level: advancing ? "info" : "warn", metadata }
}

export function bucketCopyInReason(result: CopyInResult): string {
  if (result.outcome === "hydrated") return "hydrated"
  if (result.outcome === "noop") return "noop"
  const buckets: ReadonlyArray<readonly [string, string]> = [
    [INCOMPLETE_LEGACY_HYDRATE_REASON, INCOMPLETE_LEGACY_HYDRATE_REASON],
    ["partial hydrate", "partial-hydrate"],
    ["store manifest unreadable", "manifest-unreadable"],
    ["legacy store manifest unreadable", "manifest-unreadable"],
    ["the download threw", "download-error"],
  ]
  return buckets.find(([prefix]) => result.message.startsWith(prefix))?.[1] ?? "error"
}

export function classifyCopyInFailure(result: CopyInResult): string {
  if (result.outcome !== "failed") return ""
  if (result.message.startsWith("lock-held")) return "lock-held"

  const description = (result.issues[0] ?? result.message).toLowerCase()
  const checks: ReadonlyArray<readonly [RegExp, string]> = [
    [/no inference credential/, "no-credential"],
    [/\b(401|403)\b|forbidden|access denied|unauthorized|unauthenticated|notloggedin|does not have access|not authorized|access is not enabled/, "auth"],
    [/timed?\s?out|etimedout|deadline/, "timeout"],
    [/enotfound|econnrefused|econnreset|fetch failed|network|socket|getaddrinfo|dns/, "network"],
    [/nosuchkey|presign|amazonaws|s3|bucket/, "s3"],
  ]
  return checks.find(([pattern]) => pattern.test(description))?.[1] ?? "unknown"
}

export function isTransientCopyInFailure(result: CopyInResult): boolean {
  if (result.outcome !== "failed") return false
  const stableFailures = ["store.db coverage is below", "no store.db identities to validate", "the legacy source's manifest is empty"]
  if (stableFailures.some(text => result.message.includes(text))) return false
  if (result.message.startsWith("partial hydrate") || result.message.startsWith(INCOMPLETE_LEGACY_HYDRATE_REASON)) return true
  return !new Set(["auth", "no-credential", "lock-held"]).has(classifyCopyInFailure(result))
}

export function redactCopyInErrorForTelemetry(raw: string): string {
  const protectedText = raw
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
  return protectedText.slice(0, 200)
}

const EXIT_CODE_BY_OUTCOME: Readonly<Record<CopyInResult["outcome"], number>> = {
  hydrated: BOX_COPY_IN_EXIT_HYDRATED,
  noop: BOX_COPY_IN_EXIT_NOOP,
  failed: BOX_COPY_IN_EXIT_FAILED,
}

export function outcomeToExitCode(outcome: CopyInResult["outcome"]): number {
  return EXIT_CODE_BY_OUTCOME[outcome]
}
