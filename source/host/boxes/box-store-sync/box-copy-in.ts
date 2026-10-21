/**
 * Filling a fresh box from its store.
 *
 * This is the one host path that runs before the host: a box boots empty, this process pulls its store down, and then the
 * real host starts on top of what it restored. Everything here is written for that situation:
 *
 * - **it fails closed** — a store that cannot be read, a lock another writer holds, a manifest that does not match what is
 *   on disk: each ends with a non-zero exit and a status file that says why, because starting a host on a half-restored
 *   store is worse than not starting it;
 * - **a legacy store is a source, not a fallback** — when the box's store was written by the older backend, its manifest is
 *   the authoritative list; a partial hydrate is recorded as partial (`incomplete_legacy_hydrate`) and retried, and the
 *   handoff marker is only written after a restore that covered every store database the legacy source advertised;
 * - **it reports while it runs** — a status file for the desktop (throttled), structured telemetry for the platform, and a
 *   watchdog that says whether the copy is stuck or merely slow, with the symlink step it is in;
 * - **it can be retried safely** — a transient failure (not auth, not a missing credential, not a held lock) is retried with
 *   backoff, and a restore is idempotent because every file is verified against its hash.
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createDeadlinePolicy,
  createDebouncePolicy,
  createIdleWatchdogPolicy,
  createPollingPolicy,
  createRetryPolicy,
  realClock,
  type DebouncePolicy,
  type RetryPolicy,
} from "../../extensions/scheduling.ts";
import { isAgentStoreSourceId } from "../../../packages/constants/agent-store-ids.ts";
import { tryAcquireStoreLock } from "../../../packages/agent-store-sync/store-lock.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { STRUCTURED_LOG_SUBMIT_DEADLINE_MS } from "../../../shared/observability/structured-log-transport.ts";
import { getSlateInferenceBackendUrl } from "../../../shared/node/cursor-backend/cursor-inference.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { getOrCreateHostMachineId } from "../../host-secret-store.ts";
import { getBoxStoreBackendPolicy, isBoxStoreCopyInEnabled } from "../box-store-backend-policy.ts";
import { resolveBoxIdentityTags } from "../../ports/telemetry.ts";
import { SlateSourceMap } from "../../extensions/source-map/source-map-service.ts";
import {
  readDevInferenceCredentialFile,
  renewBoxInferenceCredential,
  SLATE_DEV_INFERENCE_TOKEN_FILE_ENV,
  SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV,
  type InferenceCredential,
} from "../../auth/credential-renewer.ts";
import { SlateStructuredLogTelemetry, TELEMETRY_FLUSH_TICK_MS } from "../../telemetry/structured-log-telemetry.ts";
import { pinBoxStoreDiagnosticsReporter } from "./box-store-diagnostics.ts";
import type { BoxStoreDownloadOptions, BoxStoreDownloadSummary, BoxStoreDownloadTrace } from "./box-store-download.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME, INCOMPLETE_LEGACY_HYDRATE_REASON, isBoxStoreFullyHydrated } from "./box-store-hydration.ts";
import { countStoreDbManifestEntries, getStoreDbManifestAgentIds, type BoxManifestMap } from "./box-store-manifest.ts";
import { SLATE_MANIFEST_V2_ENV } from "./box-store-manifest-format.ts";
import { AgentStoreObjectStoreProvider, resolveBoxObjectStoreProvider } from "./box-object-store.ts";
import { BoxStoreSync } from "./box-store-sync.ts";
import { BoxStoreSyncError } from "./box-store-sync-error.ts";
import { BOX_STORE_MANIFEST_RETRY_ATTEMPTS, BOX_STORE_MANIFEST_RETRY_DELAY_MS } from "./box-store-sync-service.ts";
import { BoxStoreCanonicalWriteConflictError } from "./object-store-port.ts";

export const BOX_COPY_IN_EXIT_NOOP = 0;
export const BOX_COPY_IN_EXIT_FAILED = 1;
export const BOX_COPY_IN_EXIT_HYDRATED = 10;
export const SLATE_BOX_COPY_IN_STATUS_PATH = "/tmp/slate-copy-in-status.json";
export const COPY_IN_STATUS_THROTTLE_MS = 750;
export const COPY_IN_HYDRATE_ATTEMPTS = 8;
export const COPY_IN_STUCK_THRESHOLD_MS = 5 * 60_000;

const COPY_IN_RETRY_ATTEMPTS = 5;
const COPY_IN_RETRY_BASE_MS = 1_000;
const COPY_IN_RETRY_MAX_MS = 15_000;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const BOX_HOME_DIR = "/home/box";

const COPY_IN_CREDENTIAL_RETRY = createRetryPolicy(realClock, { name: "box-copy-in-inference-credential", maxAttempts: COPY_IN_RETRY_ATTEMPTS, initialDelayMs: COPY_IN_RETRY_BASE_MS, maxDelayMs: COPY_IN_RETRY_MAX_MS });
const COPY_IN_STORE_DB_DEBOUNCE = createDebouncePolicy(realClock, { name: "box-copy-in-store-db", delayMs: 0 });
const COPY_IN_MANIFEST_RETRY = createRetryPolicy(realClock, {
  name: "box-copy-in-manifest",
  maxAttempts: BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  initialDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  maxDelayMs: BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  shouldRetry: (error) => error instanceof BoxStoreCanonicalWriteConflictError,
});

export interface CopyInResult {
  outcome: "hydrated" | "noop" | "failed";
  reason: string;
  manifestEntries: number;
  storeDbEntries: number;
  restoredStoreDbEntries?: number;
  files: number;
  bytes: number;
  verified: number;
  failures: string[];
  hydrateSource?: "legacy";
}

interface CopyInSync {
  readonly manifestV2Enabled?: boolean | undefined;
  readManifestStrict(): Promise<BoxManifestMap>;
  readManifestStrictDetailed(): Promise<{ present: boolean; manifest: BoxManifestMap; fullyHydrated?: boolean | undefined }>;
  enrollManifestV2?(): void;
  download(targetDir: string, options?: BoxStoreDownloadOptions): Promise<BoxStoreDownloadSummary>;
  markLegacyHydrationIncomplete?(): Promise<void>;
  markLegacyHydrationCompleteForHandoff?(): Promise<void>;
}

interface CopyInTraceStatus {
  copyStage?: "manifest" | "symlink";
  fileEntries?: number;
  symlinkEntries?: number;
  symlinksStarted?: number;
  symlinksCompleted?: number;
  symlinksInFlight?: number;
  activeSymlinkSteps?: Record<string, number>;
}

export function resolveCopyInConcurrency(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.SLATE_BOX_STORE_COPY_IN_CONCURRENCY?.trim();
  if (raw == null || raw === "") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveCopyInAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLATE_BOX_COPY_IN_ATTEMPTS?.trim();
  if (raw == null || raw === "") return COPY_IN_HYDRATE_ATTEMPTS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : COPY_IN_HYDRATE_ATTEMPTS;
}

export function resolveCopyInStuckThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLATE_BOX_COPY_IN_STUCK_MS?.trim();
  if (raw == null || raw === "") return COPY_IN_STUCK_THRESHOLD_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : COPY_IN_STUCK_THRESHOLD_MS;
}

/** What a platform reader is told: a failed hydrate that got part of the store in is *partial*, not failed. */
export function classifyCopyInMeteredOutcome(result: CopyInResult): "hydrated" | "empty" | "partial" | "failed" {
  if (result.outcome === "hydrated") return "hydrated";
  if (result.outcome === "noop") return "empty";
  return result.reason.startsWith("partial hydrate") || result.reason.startsWith(INCOMPLETE_LEGACY_HYDRATE_REASON) ? "partial" : "failed";
}

export function buildCopyInStatusFromResult(result: CopyInResult): Record<string, unknown> {
  return {
    phase: result.outcome === "failed" ? "failed" : "done",
    restored: result.files,
    total: result.manifestEntries,
    bytes: result.bytes,
    outcome: classifyCopyInMeteredOutcome(result),
    storeDbEntries: result.storeDbEntries,
  };
}

/** A status file the desktop can read while the copy runs: written whole through a rename, and throttled. */
export function makeCopyInStatusWriter(path = SLATE_BOX_COPY_IN_STATUS_PATH, now: () => number = Date.now): (status: unknown, options?: { force?: boolean }) => void {
  let lastWriteMs = 0;
  return (status, options) => {
    const timestamp = now();
    if (!(options?.force ?? false) && timestamp - lastWriteMs < COPY_IN_STATUS_THROTTLE_MS) return;
    lastWriteMs = timestamp;
    try {
      const tempPath = `${path}.tmp`;
      writeFileSync(tempPath, JSON.stringify(status));
      renameSync(tempPath, path);
    } catch {
      // The status file is for the desktop's eyes: a write that fails must not fail the copy.
    }
  };
}

/** The watchdog's story of the copy: moving-but-slow, or stuck, and in which symlink step. */
export function buildCopyInWatchdogEvent(input: {
  progressedSinceLastTick: boolean;
  progress: { total: number; files: number; bytes: number };
  elapsedMs: number;
  thresholdMs: number;
  trace?: CopyInTraceStatus;
}): { level: "info" | "warn"; metadata: Record<string, string> } {
  const metadata: Record<string, string> = {
    outcome: input.progressedSinceLastTick ? "slow" : "stuck",
    reason: input.progressedSinceLastTick ? "moving-data-in-slow-but-advancing" : "moving-data-in-exceeded-threshold",
    manifest_entries: String(input.progress.total),
    files: String(input.progress.files),
    bytes: String(input.progress.bytes),
    duration_ms: String(input.elapsedMs),
    threshold_ms: String(input.thresholdMs),
  };
  const trace = input.trace;
  if (trace?.copyStage != null) metadata.stage = trace.copyStage;
  if (trace?.fileEntries != null) metadata.file_entries = String(trace.fileEntries);
  if (trace?.symlinkEntries != null) metadata.symlink_entries = String(trace.symlinkEntries);
  if (trace?.symlinksStarted != null) metadata.symlinks_started = String(trace.symlinksStarted);
  if (trace?.symlinksCompleted != null) metadata.symlinks_completed = String(trace.symlinksCompleted);
  if (trace?.symlinksInFlight != null) metadata.symlinks_in_flight = String(trace.symlinksInFlight);
  if (trace?.activeSymlinkSteps != null) {
    const activeSteps = Object.entries(trace.activeSymlinkSteps)
      .filter(([, count]) => count > 0)
      .map(([step, count]) => `${step}:${count}`)
      .join(",");
    if (activeSteps !== "") metadata.active_symlink_steps = activeSteps;
  }
  return { level: input.progressedSinceLastTick ? "info" : "warn", metadata };
}

/** A root copy-in restores files as the box's user, not as root: the home directory names the owner. */
async function resolveCopyInDownloadOwner(deps?: { getuid?: () => number; statHomeDir?: () => Promise<{ uid: number; gid: number }> }): Promise<{ uid: number; gid: number } | undefined> {
  const getuid = deps?.getuid ?? process.getuid;
  if (getuid == null || getuid() !== 0) return undefined;
  try {
    const home = await (deps?.statHomeDir ?? (() => stat(BOX_HOME_DIR)))();
    return home.uid > 0 ? { uid: home.uid, gid: home.gid } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One hydrate attempt.
 *
 * The order is what makes it safe to retry: read the manifest strictly (a present-but-unreadable manifest is a failure, not
 * an empty store), decide whether a legacy store is the source, record that the legacy hydrate is in progress, restore, and
 * only then decide whether it was complete.
 */
export async function runBoxCopyIn(deps: {
  sync: CopyInSync;
  legacySync?: CopyInSync | undefined;
  targetDir: string;
  downloadOwner?: { uid: number; gid: number } | undefined;
  log?: ((message: string) => void) | undefined;
  onProgress?: BoxStoreDownloadOptions["onProgress"] | undefined;
  onTrace?: BoxStoreDownloadOptions["onTrace"] | undefined;
}): Promise<CopyInResult> {
  const log = deps.log ?? (() => {});
  let manifestPresent: boolean;
  let manifest: BoxManifestMap;
  let primaryFullyHydrated: boolean | undefined;
  try {
    ({ present: manifestPresent, manifest, fullyHydrated: primaryFullyHydrated } = await deps.sync.readManifestStrictDetailed());
  } catch (error) {
    return { outcome: "failed", reason: `store manifest unreadable: ${errorMessage(error)}`, manifestEntries: 0, storeDbEntries: 0, files: 0, bytes: 0, verified: 0, failures: [errorMessage(error)] };
  }

  let downloadVia = deps.sync;
  let hydrateSource: "legacy" | undefined;
  let downloadFromLegacy = false;
  let authoritativeStoreDbEntries: number | undefined;
  let authoritativeStoreDbAgentIds: Set<string> | undefined;
  if ((!manifestPresent || primaryFullyHydrated === false) && deps.legacySync != null) {
    let legacyManifest: BoxManifestMap;
    try {
      legacyManifest = await deps.legacySync.readManifestStrict();
    } catch (error) {
      return {
        outcome: "failed",
        reason: `legacy store manifest unreadable: ${errorMessage(error)}`,
        manifestEntries: 0,
        storeDbEntries: 0,
        files: 0,
        bytes: 0,
        verified: 0,
        failures: [errorMessage(error)],
        hydrateSource: "legacy",
      };
    }
    if (legacyManifest.size > 0) {
      if (deps.legacySync.manifestV2Enabled === true) deps.sync.enrollManifestV2?.();
      authoritativeStoreDbEntries = countStoreDbManifestEntries(legacyManifest);
      authoritativeStoreDbAgentIds = getStoreDbManifestAgentIds(legacyManifest);
      hydrateSource = "legacy";
      if (primaryFullyHydrated === false && manifest.size > 0) {
        // A primary store that is not sealed is only usable if it already covers every agent the legacy store has: the
        // newer store wins, but only when nothing would be lost by it.
        const primaryStoreDbAgentIds = getStoreDbManifestAgentIds(manifest);
        if (authoritativeStoreDbAgentIds.size === 0) {
          return {
            outcome: "failed",
            reason: `${INCOMPLETE_LEGACY_HYDRATE_REASON} the legacy source has no store.db identities to validate the newer store`,
            manifestEntries: manifest.size,
            storeDbEntries: 0,
            restoredStoreDbEntries: 0,
            files: 0,
            bytes: 0,
            verified: 0,
            failures: ["the legacy source's store.db identity set is empty"],
            hydrateSource,
          };
        }
        const primaryCoversLegacyAgents = [...authoritativeStoreDbAgentIds].every((agentId) => primaryStoreDbAgentIds.has(agentId));
        if (!primaryCoversLegacyAgents) {
          return {
            outcome: "failed",
            reason: `${INCOMPLETE_LEGACY_HYDRATE_REASON} the newer store's store.db coverage is below the legacy source`,
            manifestEntries: manifest.size,
            storeDbEntries: authoritativeStoreDbEntries,
            restoredStoreDbEntries: [...authoritativeStoreDbAgentIds].filter((agentId) => primaryStoreDbAgentIds.has(agentId)).length,
            files: 0,
            bytes: 0,
            verified: 0,
            failures: ["incomplete store.db agent coverage in the newer store"],
            hydrateSource,
          };
        }
        log(`the newer store's manifest is not sealed but covers all ${authoritativeStoreDbEntries} legacy store.db entries; hydrating the newer store`);
      } else {
        log(`this box's store was never seeded; hydrating ${legacyManifest.size} entries from the legacy store`);
        manifest = legacyManifest;
        downloadVia = deps.legacySync;
        downloadFromLegacy = true;
      }
    } else if (primaryFullyHydrated === false) {
      return {
        outcome: "failed",
        reason: "the legacy source's manifest is empty while the newer store is incomplete",
        manifestEntries: manifest.size,
        storeDbEntries: countStoreDbManifestEntries(manifest),
        restoredStoreDbEntries: 0,
        files: 0,
        bytes: 0,
        verified: 0,
        failures: ["the legacy source's manifest is empty"],
        hydrateSource: "legacy",
      };
    }
  }

  if (manifest.size === 0) return empty("the store is empty; this is a first boot");
  if (hydrateSource === "legacy") {
    // Before anything is written: the newer store records that a legacy hydrate is in progress, so a crash mid-restore is
    // visible to the next boot instead of looking like a complete store.
    try {
      if (deps.sync.markLegacyHydrationIncomplete == null) throw new BoxStoreSyncError("the primary store cannot mark a legacy hydrate incomplete");
      await deps.sync.markLegacyHydrationIncomplete();
    } catch (error) {
      return {
        outcome: "failed",
        reason: `failed to mark the legacy hydrate incomplete: ${errorMessage(error)}`,
        manifestEntries: manifest.size,
        storeDbEntries: countStoreDbManifestEntries(manifest),
        files: 0,
        bytes: 0,
        verified: 0,
        failures: [errorMessage(error)],
        hydrateSource,
      };
    }
  }

  const advertisedStoreDbEntries = authoritativeStoreDbEntries ?? countStoreDbManifestEntries(manifest);
  let summary: BoxStoreDownloadSummary;
  try {
    summary = await downloadVia.download(deps.targetDir, { manifest, onProgress: deps.onProgress!, onTrace: deps.onTrace!, ...deps.downloadOwner });
  } catch (error) {
    return {
      outcome: "failed",
      reason: `the download threw: ${errorMessage(error)}`,
      manifestEntries: manifest.size,
      storeDbEntries: advertisedStoreDbEntries,
      restoredStoreDbEntries: 0,
      files: 0,
      bytes: 0,
      verified: 0,
      failures: [errorMessage(error)],
      ...(hydrateSource === undefined ? {} : { hydrateSource }),
    };
  }

  // How many store databases really landed: the legacy source's list is the count that matters when it exists.
  const restoredStoreDbEntries =
    authoritativeStoreDbAgentIds == null
      ? countStoreDbManifestEntries(new Map([...manifest].filter(([relPath]) => existsSync(join(deps.targetDir, relPath)))))
      : [...authoritativeStoreDbAgentIds].filter((agentId) => existsSync(join(deps.targetDir, "home/box/slate-data/agents", agentId, "store.db"))).length;
  const legacyStoreDbsComplete = restoredStoreDbEntries >= advertisedStoreDbEntries;
  const fullyHydrated =
    isBoxStoreFullyHydrated({
      hydrateSource: downloadFromLegacy ? "legacy" : (undefined as never),
      failures: summary.failures,
      manifestEntries: manifest.size,
      files: summary.files,
      verified: summary.verified,
      authoritativeStoreDbEntries: advertisedStoreDbEntries,
      restoredStoreDbEntries,
    }) && (hydrateSource !== "legacy" || legacyStoreDbsComplete);

  if (!fullyHydrated) {
    log(`partial hydrate: ${summary.files}/${manifest.size} files, ${summary.failures.length} failures`);
    const reason =
      hydrateSource === "legacy" && !legacyStoreDbsComplete
        ? `${INCOMPLETE_LEGACY_HYDRATE_REASON} advertised_store_db=${advertisedStoreDbEntries} restored_store_db=${restoredStoreDbEntries} advisory_advertised_files=${manifest.size} advisory_restored_files=${summary.files}`
        : `partial hydrate (${summary.files}/${manifest.size} files, ${summary.failures.length} failures)`;
    return {
      outcome: "failed",
      reason,
      manifestEntries: manifest.size,
      storeDbEntries: advertisedStoreDbEntries,
      restoredStoreDbEntries,
      files: summary.files,
      bytes: summary.bytes,
      verified: summary.verified,
      failures: summary.failures,
      ...(hydrateSource === undefined ? {} : { hydrateSource }),
    };
  }

  if (hydrateSource === "legacy") {
    try {
      if (deps.sync.markLegacyHydrationCompleteForHandoff == null) throw new BoxStoreSyncError("the primary store cannot persist the legacy hydrate handoff");
      await deps.sync.markLegacyHydrationCompleteForHandoff();
    } catch (error) {
      // The data is in; a marker that could not be written only means the next boot hydrates again.
      log(`failed to persist the legacy hydrate handoff after a complete restore: ${errorMessage(error)}`);
    }
  }
  return {
    outcome: "hydrated",
    reason: hydrateSource === "legacy" ? "the store was hydrated from the legacy store" : "the store was hydrated",
    manifestEntries: manifest.size,
    storeDbEntries: advertisedStoreDbEntries,
    files: summary.files,
    bytes: summary.bytes,
    verified: summary.verified,
    failures: [],
    ...(hydrateSource === undefined ? {} : { hydrateSource }),
  };
}

/** Retries a transient hydrate, and remembers the legacy manifest it was first given so a retry sees the same list. */
async function runBoxCopyInWithRetry(
  deps: Parameters<typeof runBoxCopyIn>[0],
  options: { attempts: number; backoffMs(attempt: number): number; sleep(ms: number, attempt: number): Promise<void> },
): Promise<CopyInResult> {
  let advertisedLegacyManifest: BoxManifestMap | undefined;
  const legacySync = deps.legacySync;
  const retryDeps =
    legacySync == null
      ? deps
      : {
          ...deps,
          legacySync: {
            get manifestV2Enabled() {
              return legacySync.manifestV2Enabled;
            },
            download: legacySync.download.bind(legacySync),
            readManifestStrictDetailed: legacySync.readManifestStrictDetailed.bind(legacySync),
            readManifestStrict: async () => {
              if (advertisedLegacyManifest != null) return advertisedLegacyManifest;
              const liveLegacyManifest = await legacySync.readManifestStrict();
              if (liveLegacyManifest.size > 0) advertisedLegacyManifest = liveLegacyManifest;
              return liveLegacyManifest;
            },
          },
        };
  let result = await runBoxCopyIn(retryDeps);
  for (let attempt = 1; attempt < options.attempts && isTransientCopyInFailure(result); attempt += 1) {
    const backoff = options.backoffMs(attempt);
    deps.log?.(`copy-in failed transiently (attempt ${attempt}/${options.attempts}): ${result.reason}; retrying in ${backoff}ms`);
    await options.sleep(backoff, attempt);
    result = await runBoxCopyIn(retryDeps);
  }
  return result;
}

/**
 * The process the box runs at boot: no-op when copy-in is disabled or the box has no store, otherwise a hydrate with a
 * status file, telemetry, a stuck watchdog and a lock — and an exit code that says what happened.
 */
export async function executeBoxCopyInFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const startedAt = Date.now();
  const log = (message: string) => console.log(`[box-copy-in] ${message}`);
  if (!isBoxStoreCopyInEnabled(env)) {
    log("disabled (SLATE_BOX_STORE_COPY_IN is not truthy); no-op");
    return BOX_COPY_IN_EXIT_NOOP;
  }
  const slateRoot = getSlateRootDir();
  const storeId = await resolveCopyInStoreId(env, new SlateSourceMap());
  if (storeId == null) {
    log("no per-box store id (SLATE_BOX_STORE_ID unset and no source-map entry); booting fresh — no-op");
    return BOX_COPY_IN_EXIT_NOOP;
  }
  const backendPolicy = getBoxStoreBackendPolicy(env);
  const accessToken = backendPolicy.localDir != null ? null : makeCopyInAccessTokenGetter(env, getSlateInferenceBackendUrl(), log);
  const sync = new BoxStoreSync({
    objectStoreProvider: resolveBoxObjectStoreProvider({ env, agentStore: { getAccessToken: accessToken ?? (async () => ""), getMachineId: () => getOrCreateHostMachineId() } }),
    resolveStoreId: async () => storeId,
    categories: [],
    manifestV2: env[SLATE_MANIFEST_V2_ENV] === "1",
    storeDbDebounce: COPY_IN_STORE_DB_DEBOUNCE,
    manifestRetry: COPY_IN_MANIFEST_RETRY,
    hydrationHandoffMarkerPath: join(slateRoot, BOX_STORE_HYDRATION_HANDOFF_FILE_NAME),
    downloadConcurrency: resolveCopyInConcurrency(env)!,
    log,
  });
  // The legacy store is only a source when the box's backend is the newer one: it is the store that backend replaced.
  const legacySync =
    backendPolicy.kind === "slate-box-store-v2"
      ? new BoxStoreSync({
          objectStoreProvider: new AgentStoreObjectStoreProvider({ getAccessToken: accessToken ?? (async () => ""), getMachineId: () => getOrCreateHostMachineId() }),
          resolveStoreId: async () => storeId,
          categories: [],
          manifestV2: env[SLATE_MANIFEST_V2_ENV] === "1",
          storeDbDebounce: COPY_IN_STORE_DB_DEBOUNCE,
          manifestRetry: COPY_IN_MANIFEST_RETRY,
          downloadConcurrency: resolveCopyInConcurrency(env)!,
          log: (message) => log(`[legacy] ${message}`),
        })
      : undefined;
  const telemetry = new SlateStructuredLogTelemetry({
    getAccessToken: async () => {
      if (accessToken == null) return "";
      try {
        return await accessToken();
      } catch {
        return "";
      }
    },
    getMachineId: () => getOrCreateHostMachineId(),
    identityTags: { ...resolveBoxIdentityTags(env), store_backend: backendPolicy.kind },
    flushPolling: createPollingPolicy(realClock, { name: "slate-box-copy-in-telemetry-flush", intervalMs: TELEMETRY_FLUSH_TICK_MS }),
    submitDeadline: createDeadlinePolicy(realClock, { name: "slate-box-copy-in-structured-log-submit", timeoutMs: STRUCTURED_LOG_SUBMIT_DEADLINE_MS }),
  });
  pinBoxStoreDiagnosticsReporter((diagnostic) => telemetry.reportHostExtensionDiagnostic(diagnostic as Parameters<typeof telemetry.reportHostExtensionDiagnostic>[0]));

  let lastProgress = { files: 0, bytes: 0, total: 0 };
  let progressEvents = 0;
  let lastTraceStatus: CopyInTraceStatus = {};
  const reportCopyIn = (result: CopyInResult) => {
    telemetry.reportBoxCopyIn(result.outcome === "failed" ? "error" : "info", {
      outcome: result.outcome,
      hydrate_source: result.hydrateSource,
      reason: bucketCopyInReason(result),
      error_class: classifyCopyInFailure(result),
      error_summary: result.outcome === "failed" ? redactCopyInErrorForTelemetry(result.failures[0] ?? result.reason) : "",
      manifest_entries: String(result.manifestEntries),
      store_db_entries: String(result.storeDbEntries),
      restored_store_db_entries: result.restoredStoreDbEntries == null ? undefined : String(result.restoredStoreDbEntries),
      files: String(result.files),
      bytes: String(result.bytes),
      verified: String(result.verified),
      failures: String(result.failures.length),
      duration_ms: String(Date.now() - startedAt),
    });
  };
  telemetry.reportBoxCopyIn("info", { outcome: "started", reason: "hydrate-started", duration_ms: "0" });

  const stuckThresholdMs = resolveCopyInStuckThresholdMs(env);
  let progressEventsAtLastTick = 0;
  const stuckWatchdog = createIdleWatchdogPolicy(realClock, { name: "box-copy-in-stuck", idleMs: stuckThresholdMs });
  const stuckWatchdogHandle = stuckWatchdog.arm(() => {
    const elapsedMs = Date.now() - startedAt;
    const tick = buildCopyInWatchdogEvent({
      elapsedMs,
      thresholdMs: stuckThresholdMs,
      progressedSinceLastTick: progressEvents > progressEventsAtLastTick,
      progress: lastProgress,
      trace: lastTraceStatus,
    });
    progressEventsAtLastTick = progressEvents;
    log(`STILL copying after ${elapsedMs}ms (files=${lastProgress.files}/${lastProgress.total} bytes=${lastProgress.bytes} active_symlink_steps=${tick.metadata.active_symlink_steps ?? "none"}); emitting the ${tick.metadata.outcome} event`);
    telemetry.reportBoxCopyIn(tick.level, tick.metadata);
    stuckWatchdogHandle.kick();
  });

  try {
    const lockPath = join(slateRoot, "box-store-sync.lock");
    const lock = await acquireCopyInLock(lockPath, log);
    if (lock == null) {
      log("could not acquire the box-store lock (a live writer?); failing closed");
      const lockResult: CopyInResult = { outcome: "failed", reason: "lock-held", manifestEntries: 0, storeDbEntries: 0, files: 0, bytes: 0, verified: 0, failures: [] };
      makeCopyInStatusWriter()(buildCopyInStatusFromResult(lockResult), { force: true });
      reportCopyIn(lockResult);
      return BOX_COPY_IN_EXIT_FAILED;
    }
    const writeStatus = makeCopyInStatusWriter();
    writeStatus({ phase: "copying", restored: 0, total: 0, bytes: 0 }, { force: true });
    try {
      const hydrateAttempts = resolveCopyInAttempts(env);
      const hydrateRetry = createRetryPolicy(realClock, { name: "box-copy-in-hydrate", maxAttempts: hydrateAttempts, initialDelayMs: COPY_IN_RETRY_BASE_MS, maxDelayMs: COPY_IN_RETRY_MAX_MS });
      const result = await runBoxCopyInWithRetry(
        {
          sync,
          ...(legacySync === undefined ? {} : { legacySync }),
          targetDir: "/",
          downloadOwner: (await resolveCopyInDownloadOwner())!,
          log,
          onProgress: (progress) => {
            progressEvents += 1;
            lastProgress = { files: progress.files, bytes: progress.bytes, total: progress.total };
            writeStatus({ phase: "copying", restored: progress.files, total: progress.total, bytes: progress.bytes, ...lastTraceStatus });
          },
          onTrace: (trace: BoxStoreDownloadTrace) => {
            lastTraceStatus = {
              copyStage: trace.event === "manifest-planned" ? "manifest" : "symlink",
              fileEntries: trace.fileEntries,
              symlinkEntries: trace.symlinkEntries,
              symlinksStarted: trace.symlinksStarted,
              symlinksCompleted: trace.symlinksCompleted,
              symlinksInFlight: trace.symlinksInFlight,
              activeSymlinkSteps: trace.activeSymlinkSteps,
            };
          },
        },
        {
          attempts: hydrateAttempts,
          backoffMs: (attempt) => Math.min(COPY_IN_RETRY_BASE_MS * 2 ** (attempt - 1), COPY_IN_RETRY_MAX_MS),
          sleep: async (_ms, attempt) => {
            const wait = hydrateRetry.schedule(attempt);
            try {
              await wait.elapsed;
            } finally {
              wait.dispose();
            }
          },
        },
      );
      writeStatus(buildCopyInStatusFromResult(result), { force: true });
      log(`result outcome=${result.outcome} store_entries=${result.manifestEntries} files=${result.files} bytes=${result.bytes} verified=${result.verified} failures=${result.failures.length} duration_ms=${Date.now() - startedAt} reason="${result.reason}"`);
      for (const failure of result.failures.slice(0, 20)) log(`  failure: ${failure}`);
      reportCopyIn(result);
      return outcomeToExitCode(result.outcome);
    } catch (error) {
      const thrown: CopyInResult = { outcome: "failed", reason: `copy-in threw: ${errorMessage(error)}`, manifestEntries: 0, storeDbEntries: 0, files: 0, bytes: 0, verified: 0, failures: [errorMessage(error)] };
      writeStatus(buildCopyInStatusFromResult(thrown), { force: true });
      reportCopyIn(thrown);
      return BOX_COPY_IN_EXIT_FAILED;
    } finally {
      await lock.release().catch(() => {});
    }
  } finally {
    stuckWatchdogHandle.dispose();
    await telemetry.dispose().catch(() => {});
  }
}

/** The reason in a bucket a dashboard can count, rather than as free text. */
export function bucketCopyInReason(result: CopyInResult): string {
  if (result.outcome === "hydrated") return "hydrated";
  if (result.outcome === "noop") return "noop";
  if (result.reason.startsWith(INCOMPLETE_LEGACY_HYDRATE_REASON)) return INCOMPLETE_LEGACY_HYDRATE_REASON;
  if (result.reason.startsWith("partial hydrate")) return "partial-hydrate";
  if (result.reason.startsWith("store manifest unreadable") || result.reason.startsWith("legacy store manifest unreadable")) return "manifest-unreadable";
  if (result.reason.startsWith("the download threw")) return "download-error";
  return "error";
}

/** The class of a failure, from the first thing that went wrong: this is what decides whether a retry makes sense. */
export function classifyCopyInFailure(result: CopyInResult): string {
  if (result.outcome !== "failed") return "";
  if (result.reason.startsWith("lock-held")) return "lock-held";
  const text = (result.failures[0] ?? result.reason).toLowerCase();
  if (/no inference credential/.test(text)) return "no-credential";
  if (/\b(401|403)\b|forbidden|access denied|unauthorized|unauthenticated|notloggedin|does not have access|not authorized|access is not enabled/.test(text)) return "auth";
  if (/timed?\s?out|etimedout|deadline/.test(text)) return "timeout";
  if (/enotfound|econnrefused|econnreset|fetch failed|network|socket|getaddrinfo|dns/.test(text)) return "network";
  if (/nosuchkey|presign|amazonaws|s3|bucket/.test(text)) return "s3";
  return "unknown";
}

/** Whether a hydrate is worth another attempt: a partial restore is, a permission problem is not. */
export function isTransientCopyInFailure(result: CopyInResult): boolean {
  if (result.outcome !== "failed") return false;
  if (
    result.reason.includes("store.db coverage is below") ||
    result.reason.includes("no store.db identities to validate") ||
    result.reason.startsWith("the legacy source's manifest is empty")
  ) {
    return false;
  }
  if (result.reason.startsWith("partial hydrate") || result.reason.startsWith(INCOMPLETE_LEGACY_HYDRATE_REASON)) return true;
  const classification = classifyCopyInFailure(result);
  return classification !== "auth" && classification !== "no-credential" && classification !== "lock-held";
}

/** An error message with urls, paths and ids taken out: it goes to telemetry, not to a log file. */
export function redactCopyInErrorForTelemetry(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function outcomeToExitCode(outcome: CopyInResult["outcome"]): number {
  switch (outcome) {
    case "hydrated":
      return BOX_COPY_IN_EXIT_HYDRATED;
    case "failed":
      return BOX_COPY_IN_EXIT_FAILED;
    case "noop":
      return BOX_COPY_IN_EXIT_NOOP;
  }
}

async function resolveCopyInStoreId(env: NodeJS.ProcessEnv, sourceMap: Pick<SlateSourceMap, "getBoxStore">): Promise<string | null> {
  const override = env.SLATE_BOX_STORE_ID?.trim();
  if (override != null && override.length > 0 && isAgentStoreSourceId(override)) return override;
  return (await sourceMap.getBoxStore())?.sourceId ?? null;
}

/** An access token for the store, cached until it is close to expiring (a copy can take longer than one token's life). */
function makeCopyInAccessTokenGetter(env: NodeJS.ProcessEnv, backendUrl: string, log: (message: string) => void): () => Promise<string> {
  let cached: InferenceCredential | undefined;
  return async () => {
    if (cached != null && cached.expiresAtMs - Date.now() > TOKEN_REFRESH_LEEWAY_MS) return cached.accessToken;
    const renewed = await withRetry("inference credential", () => fetchCopyInCredential(env, backendUrl), log);
    cached = renewed;
    return renewed.accessToken;
  };
}

/** A dev token file if this is a dev box, otherwise the renewal credential the box was booted with. */
async function fetchCopyInCredential(env: NodeJS.ProcessEnv, backendUrl: string): Promise<InferenceCredential> {
  const devTokenFile = env[SLATE_DEV_INFERENCE_TOKEN_FILE_ENV]?.trim();
  if (devTokenFile != null && devTokenFile.length > 0) return readDevInferenceCredentialFile({ path: devTokenFile });
  const credential = env[SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV]?.trim();
  if (credential != null && credential.length > 0) return renewBoxInferenceCredential({ backendUrl, credential });
  throw new BoxStoreSyncError(`no inference credential for copy-in (set ${SLATE_INFERENCE_RENEWAL_CREDENTIAL_ENV} or ${SLATE_DEV_INFERENCE_TOKEN_FILE_ENV})`);
}

async function acquireCopyInLock(lockPath: string, log: (message: string) => void): Promise<{ release(): Promise<void> } | null> {
  try {
    const result = await tryAcquireStoreLock({ lockPath, windowId: `slate-copy-in-${process.pid}` });
    return result.kind === "acquired" ? { release: () => result.lock.dispose() } : null;
  } catch (error) {
    log(`the store lock failed: ${errorMessage(error)}`);
    return null;
  }
}

async function withRetry<T>(label: string, work: () => Promise<T>, log: (message: string) => void): Promise<T> {
  return COPY_IN_CREDENTIAL_RETRY.runWithRetry(async (attempt) => {
    try {
      return await work();
    } catch (error) {
      if (attempt < COPY_IN_RETRY_ATTEMPTS) {
        const backoff = Math.min(COPY_IN_RETRY_BASE_MS * 2 ** (attempt - 1), COPY_IN_RETRY_MAX_MS);
        log(`${label} failed (attempt ${attempt}/${COPY_IN_RETRY_ATTEMPTS}): ${errorMessage(error)}; retrying in ${backoff}ms`);
      }
      throw error;
    }
  });
}

export function empty(reason: string): CopyInResult {
  return { outcome: "noop", reason, manifestEntries: 0, storeDbEntries: 0, files: 0, bytes: 0, verified: 0, failures: [] };
}
