/**
 * The box store's own service: what the host starts, and what other extensions ask for.
 *
 * The service exists in two shapes at once, and the difference matters:
 *
 * - **enabled** — a periodic cycle keeps the box's store in step with the platform's, a chrome-session watcher stages the
 *   browser's auth state on its own schedule, and a turn's end asks for that agent's store to be captured;
 * - **disabled** — no cycle starts at all, but the API still answers: the store can be flushed on demand, cleared, or
 *   asked for its status, because those are things a user does when they suspect something is wrong.
 *
 * Everything that leaves this file is either a hosted policy (polling, debounce, retry, clock) or a callback into the
 * extension that owns it; nothing here reads the environment except at the one point where the box's layout is decided.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock, DebouncePolicy, PollingPolicy, RetryPolicy } from "../../extensions/scheduling.ts";
import { BOX_PERSIST_ARCHIVE_EXCLUDES } from "../../../packages/constants/box-archive.ts";
import { isAgentStoreSourceId } from "../../../packages/constants/agent-store-ids.ts";
import { errorMessage } from "../../../shared/errors/summary.ts";
import { getBoxStoreBackendPolicy, isBoxStoreSyncEnabled, type BoxStoreBackendPolicy } from "../box-store-backend-policy.ts";
import { BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES } from "../../durable-file-policy.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import type { AgentStoreClientDependencies } from "./agent-store-slate-files.ts";
import { AgentStoreObjectStoreProvider, resolveBoxObjectStoreProvider, type BoxObjectStoreProvider } from "./box-object-store.ts";
import {
  CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES,
  CHROME_AUTH_STATE_REL_DIRS,
  CHROME_SESSION_CATEGORY_NAME,
  CHROME_SESSION_DB_DIR,
  CHROME_SESSION_DB_NAMES,
  CHROME_SESSION_DB_REL_DIR,
  stageBoxChromeSession,
  type ChromeStageReport,
} from "./chrome-session-stage.ts";
import { ChromeSessionWatcher } from "./chrome-session-watcher.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME } from "./box-store-hydration.ts";
import { SLATE_MANIFEST_V2_ENV } from "./box-store-manifest-format.ts";
import { boxStoreDbCaptureTelemetry } from "./store-db-capture.ts";
import {
  BoxStoreSync,
  boxStoreSyncCycleTelemetry,
  evaluateBoxStoreFlush,
  type BoxStoreCaptureSummary,
  type BoxStoreCategory,
  type BoxStoreCycleSummary,
} from "./box-store-sync.ts";
import { compileWorkspaceIgnore, loadWorkspaceIgnore } from "./workspace-ignore.ts";

export const SLATE_STORE_BETTER_CLI_ENV = "SLATE_STORE_BETTER_CLI";
export const BOX_HOME_CATEGORY_NAME = "home";
export const BOX_HOME_DIR = "/home/box";
export const BOX_HOME_REL_PREFIX = "home/box";
/** The trees under the home directory the store never carries: they are the box's own machinery, not the user's work. */
export const BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES = [
  `${BOX_HOME_REL_PREFIX}/cli-config`,
  `${BOX_HOME_REL_PREFIX}/chrome-profile*`,
  `${BOX_HOME_REL_PREFIX}/slate-data`,
  `${BOX_HOME_REL_PREFIX}/slate-host`,
  `${BOX_HOME_REL_PREFIX}/deps`,
] as const;
/** Caches and sockets that a store sweep should pass over: they are rebuilt, so carrying them is pure cost. */
export const BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS = [
  "/cli-config/", "/chrome-profile*/", "/slate-data/", "/slate-host/", "/deps/", ".cache/", "/.npm/", "/.nvm/", "/.rustup/",
  "/.cargo/registry/", "/.cargo/git/", "/.local/share/pnpm/", "/.local/share/Trash/", "/.local/state/", "/.docker/buildx/",
  "/.gradle/caches/", "/.gradle/daemon/", "/.gradle/wrapper/", "/.m2/repository/", "/.vnc/", "/.dbus/", "/.Xauthority", "*.sock",
] as const;
export const BOX_STORE_SYNC_INTERVAL_MS = 2 * 60_000;
export const BOX_STORE_CHROME_INTERVAL_MS = 15 * 60_000;
export const BOX_STORE_DB_DEBOUNCE_MS = 5_000;
export const CHROME_SESSION_CHANGE_DEBOUNCE_MS = 5_000;
export const BOX_STORE_MANIFEST_RETRY_ATTEMPTS = 3;
export const BOX_STORE_MANIFEST_RETRY_DELAY_MS = 100;

/** The home directory, kept as a category of its own: only a box that opted in carries it. */
export function buildBoxHomeCategory(absRoot: string): BoxStoreCategory {
  return {
    name: BOX_HOME_CATEGORY_NAME,
    absRoot,
    relPrefix: BOX_HOME_REL_PREFIX,
    excludes: BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
    ignore: () => compileWorkspaceIgnore(BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS),
  };
}

export interface BoxStoreTelemetry {
  reportBoxStoreSyncCycle(level: string, metadata: Record<string, string | undefined>): void;
  reportChromeSessionStage(level: string, metadata: Record<string, string | undefined>): void;
  reportBoxStoreManifestConflict(level: string, metadata: Record<string, string | undefined>): void;
  reportBoxStoreDbCapture(level: string, metadata: Record<string, string | undefined>): void;
}

export interface BoxStoreSyncServiceDependencies {
  env?: NodeJS.ProcessEnv;
  auth: AgentStoreClientDependencies;
  sourceMap: { getOrCreateBoxStore(): Promise<{ sourceId: string }> };
  clock: Clock;
  polling: PollingPolicy;
  storeDbDebounce: DebouncePolicy;
  chromeSessionDebounce: DebouncePolicy;
  chromeStageRetry: RetryPolicy;
  manifestRetry: RetryPolicy;
  isIdle(): boolean;
  log(message: string): void;
  telemetry: BoxStoreTelemetry;
}

export interface BoxStoreSyncApi {
  isEnabled: boolean;
  objectStoreProvider: BoxObjectStoreProvider;
  getStoreId(): Promise<string>;
  snapshotBoxStoreNow(args: { includeIdleOnly?: boolean }): Promise<ReturnType<typeof evaluateBoxStoreFlush>>;
  getBoxStoreStatus(): ReturnType<BoxStoreSync["readStoreStatus"]>;
  clearBoxStoreNow(): Promise<{ ok: boolean; reason?: string }>;
  scheduleStoreDbSnapshot(agentId: string): void;
  forgetAgent(agentId: string): Promise<void>;
}

export class DefaultBoxStoreSyncService {
  readonly api: BoxStoreSyncApi;
  readonly env: NodeJS.ProcessEnv;
  readonly slateRoot: string;
  readonly backendPolicy: BoxStoreBackendPolicy;
  readonly sync: BoxStoreSync | undefined;
  private accessorInstance: BoxStoreSync | undefined;
  private pollingHandle: { dispose(): void } | undefined;
  private chromeSessionWatcher: ChromeSessionWatcher | undefined;
  private lastChromeSyncMs: number;
  private started = false;

  constructor(readonly deps: BoxStoreSyncServiceDependencies) {
    this.env = deps.env ?? process.env;
    this.slateRoot = getSlateRootDir();
    this.backendPolicy = getBoxStoreBackendPolicy(this.env);
    const objectStoreProvider = resolveBoxObjectStoreProvider({ env: this.env, agentStore: deps.auth });
    const enabled = isBoxStoreSyncEnabled(this.env);
    this.lastChromeSyncMs = deps.clock.monotonicNow();
    // A disabled store still gets an API; it just never starts a cycle of its own.
    this.sync = enabled
      ? this.createSync(
          buildBoxStoreCategories({
            slateRoot: this.slateRoot,
            chromeStageRetry: deps.chromeStageRetry,
            reportChromeSessionStage: (outcome) => this.reportChromeSessionStage(outcome),
            env: this.env,
          }),
          objectStoreProvider,
          "[box-store-sync]",
        )
      : undefined;
    this.api = {
      isEnabled: enabled,
      objectStoreProvider,
      getStoreId: () => this.getStoreId(),
      snapshotBoxStoreNow: (args) => this.snapshotBoxStoreNow(args),
      getBoxStoreStatus: () => this.accessor().readStoreStatus(),
      clearBoxStoreNow: () => this.clearBoxStoreNow(),
      scheduleStoreDbSnapshot: (agentId) => this.sync?.scheduleStoreDbSnapshot(agentId),
      forgetAgent: async (agentId) => {
        await (this.sync ?? this.accessor()).forgetAgent(agentId);
      },
    };
  }

  /**
   * Starts the periodic cycle and the chrome-session watcher. The first cycle waits for the leaked-temp sweep, so a
   * crashed previous host's temporary files are gone before anything is measured against the store.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.sync == null) {
      this.deps.telemetry.reportBoxStoreSyncCycle("warn", { ok: "false", reason: "disabled", phase: "startup" });
      return;
    }
    const startupSweep = this.sync
      .sweepLeakedTemps()
      .then((removed) => {
        if (removed > 0) this.deps.log(`swept ${removed} leaked box-store temp file(s)`);
      })
      .catch((error) => this.deps.log(`box-store temp sweep failed: ${errorMessage(error)}`));
    this.pollingHandle = this.deps.polling.start(async () => {
      await startupSweep;
      await this.runCycle();
    });
    this.chromeSessionWatcher = new ChromeSessionWatcher({
      watchDir: CHROME_SESSION_DB_DIR,
      sessionDbNames: CHROME_SESSION_DB_NAMES,
      debounce: this.deps.chromeSessionDebounce,
      onSessionChange: () => {
        void this.sync?.snapshotNow({ chromeSessionOnly: true, waitForInFlight: true }).catch((error) => this.deps.log(`chrome-session snapshot rejected: ${errorMessage(error)}`));
      },
      log: this.deps.log,
    });
    this.chromeSessionWatcher.start();
    this.deps.log("box-store sync enabled (snapshot-out only)");
    this.deps.telemetry.reportBoxStoreSyncCycle("info", { ok: "true", reason: "enabled", phase: "startup" });
  }

  async dispose(): Promise<void> {
    this.pollingHandle?.dispose();
    this.pollingHandle = undefined;
    this.chromeSessionWatcher?.stop();
    this.chromeSessionWatcher = undefined;
    await this.sync?.dispose();
    if (this.accessorInstance != null && this.accessorInstance !== this.sync) await this.accessorInstance.dispose();
    this.accessorInstance = undefined;
  }

  private createSync(categories: readonly BoxStoreCategory[], objectStoreProvider: BoxObjectStoreProvider, logPrefix: string): BoxStoreSync {
    return new BoxStoreSync({
      resolveStoreId: () => this.getStoreId(),
      categories,
      objectStoreProvider,
      manifestV2: this.env[SLATE_MANIFEST_V2_ENV] === "1",
      hydrationHandoffMarkerPath: join(this.slateRoot, BOX_STORE_HYDRATION_HANDOFF_FILE_NAME),
      storeDbDebounce: this.deps.storeDbDebounce,
      manifestRetry: this.deps.manifestRetry,
      now: () => this.deps.clock.now(),
      log: (message) => this.deps.log(`${logPrefix} ${message}`),
      ...(categories.length > 0
        ? {
            lockPath: join(this.slateRoot, "box-store-sync.lock"),
            windowId: `slate-host-${process.pid}`,
            onCycle: (summary: BoxStoreCycleSummary) => this.reportBoxStoreSyncCycle(summary),
            onStoreDbCapture: (summary: BoxStoreCaptureSummary) => this.reportBoxStoreDbCapture(summary),
            onManifestWriteConflict: (info: Record<string, unknown>) => this.reportBoxStoreManifestConflict(info),
          }
        : {}),
    });
  }

  /** The store when it is enabled; otherwise a reader-only one that can still answer status and be cleared. */
  private accessor(): BoxStoreSync {
    if (this.sync != null) return this.sync;
    this.accessorInstance ??= this.createSync([], this.api.objectStoreProvider, "[box-store-access]");
    return this.accessorInstance;
  }

  /** The store's id: an explicit override when it is a real source id, otherwise the one the source map gives out. */
  async getStoreId(): Promise<string> {
    const override = this.env.SLATE_BOX_STORE_ID?.trim();
    if (override != null && override.length > 0 && isAgentStoreSourceId(override)) return override;
    return (await this.deps.sourceMap.getOrCreateBoxStore()).sourceId;
  }

  async snapshotBoxStoreNow(args: { includeIdleOnly?: boolean }) {
    if (this.sync == null) return { ok: false, manifestEntries: 0, storeDbEntries: 0, agentDirEntries: 0, storeDbComplete: false, filesUploaded: 0, reason: "store-sync-disabled" };
    const summary = await this.sync
      .snapshotNow({ includeIdleOnly: args.includeIdleOnly === true, includeStoreDbs: true, waitForInFlight: true, acceptMatchingCanonicalOnConflict: true })
      .catch((error) => {
        this.deps.log(`flush snapshot rejected: ${errorMessage(error)}`);
        return undefined;
      });
    return evaluateBoxStoreFlush(summary, { sessionCategoryName: CHROME_SESSION_CATEGORY_NAME });
  }

  async clearBoxStoreNow(): Promise<{ ok: boolean; reason?: string }> {
    // A store written by the v2 backend also has a legacy side; clearing only one of them would leave the box looking
    // half-reset, so the legacy store is cleared first and its failure is reported.
    if (this.backendPolicy.kind === "slate-box-store-v2") {
      const legacy = this.createSync([], new AgentStoreObjectStoreProvider(this.deps.auth), "[box-store-clear-legacy]");
      const legacyResult = await legacy.clearStore();
      await legacy.dispose();
      if (!legacyResult.ok) return { ok: false, reason: `legacy store clear failed: ${legacyResult.reason ?? "unknown"}` };
    }
    return this.accessor().clearStore();
  }

  /**
   * One periodic cycle. The idle-only categories (the chrome profile, and the home directory when opted in) are skipped
   * unless the host is idle, and the chrome session is refreshed on its own longer interval.
   */
  async runCycle(): Promise<void> {
    if (this.sync == null) return;
    const idle = this.deps.isIdle();
    const now = this.deps.clock.monotonicNow();
    const hydrationHandoffPending = existsSync(join(this.slateRoot, BOX_STORE_HYDRATION_HANDOFF_FILE_NAME));
    const sealHydrationHandoff = hydrationHandoffPending && idle;
    const includeIdleOnly = sealHydrationHandoff || (idle && now - this.lastChromeSyncMs >= BOX_STORE_CHROME_INTERVAL_MS);
    if (includeIdleOnly) this.lastChromeSyncMs = now;
    await this.sync
      .snapshotNow({ includeIdleOnly, includeStoreDbs: idle, skipLiveHandleStoreDbs: !sealHydrationHandoff, includePacks: includeIdleOnly })
      .catch((error) => this.deps.log(`periodic snapshot rejected: ${errorMessage(error)}`));
  }

  private reportChromeSessionStage(outcome: ChromeStageReport): void {
    const failure = outcome.failure;
    this.deps.telemetry.reportChromeSessionStage(outcome.skipped > 0 ? "warn" : "info", {
      staged: String(outcome.staged),
      skipped: String(outcome.skipped),
      skipped_dbs: outcome.skippedDbNames.length > 0 ? outcome.skippedDbNames.join(",") : undefined,
      error_class: outcome.errorClass ?? undefined,
      failure_db: failure?.db,
      failure_phase: failure?.phase,
      failure_operation: failure?.operation,
      failure_path_stage: failure?.pathStage,
      failure_cause: failure?.cause,
      errno: failure?.errno,
      sqlite_code: failure?.sqliteCode === undefined ? undefined : String(failure.sqliteCode),
    });
  }

  private reportBoxStoreSyncCycle(summary: BoxStoreCycleSummary): void {
    const event = boxStoreSyncCycleTelemetry(summary);
    if (event != null) this.deps.telemetry.reportBoxStoreSyncCycle(event.level, event.metadata);
  }

  private reportBoxStoreManifestConflict(info: Record<string, unknown>): void {
    this.deps.telemetry.reportBoxStoreManifestConflict("warn", {
      store_id: info.storeId as string,
      attempts: String(info.attempts),
      accepted: String(info.accepted),
      covered: String(info.covered),
      canonical_matches_attempt: String(info.canonicalMatchesAttempt),
      live_view_changed: String(info.liveViewChanged),
      attempted_entries: String(info.attemptedEntries),
      last_base_etag: info.lastBaseEtag as string | undefined,
      last_baseline_source: info.lastBaselineSource as string | undefined,
      last_conflict_rel_path: info.lastConflictRelPath as string | undefined,
      canonical_readable: String(info.canonicalReadable),
      canonical_entry_count: info.canonicalEntryCount == null ? undefined : String(info.canonicalEntryCount),
      canonical_updated_at_ms: info.canonicalUpdatedAtMs == null ? undefined : String(info.canonicalUpdatedAtMs),
      canonical_writer_window_id: info.canonicalWriterWindowId as string | undefined,
      our_window_id: info.ourWindowId as string | undefined,
    });
  }

  private reportBoxStoreDbCapture(summary: BoxStoreCaptureSummary): void {
    const event = boxStoreDbCaptureTelemetry(summary);
    this.deps.telemetry.reportBoxStoreDbCapture(event.level, event.metadata);
  }
}

/**
 * What the box carries, category by category. Each one names where it lives on the box, where it lands in the store, and
 * what it never carries: the store's own locks and markers, the browser's caches, and the regenerable junk.
 */
export function buildBoxStoreCategories(args: { slateRoot: string; chromeStageRetry: RetryPolicy; reportChromeSessionStage(outcome: ChromeStageReport): void; env: NodeJS.ProcessEnv }): BoxStoreCategory[] {
  const slateDataPrefix = "home/box/slate-data";
  return [
    {
      name: "slate-data",
      absRoot: args.slateRoot,
      relPrefix: slateDataPrefix,
      containsAgentStoreDbs: true,
      excludes: [
        `${slateDataPrefix}/host.lock`,
        `${slateDataPrefix}/gateway.json`,
        `${slateDataPrefix}/box-store-sync.lock`,
        `${slateDataPrefix}/${BOX_STORE_HYDRATION_HANDOFF_FILE_NAME}`,
        ...BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES.map((name) => `${slateDataPrefix}/${name}`),
      ],
    },
    { name: "workspace", absRoot: "/workspace", relPrefix: "workspace", ignore: () => loadWorkspaceIgnore("/workspace") },
    {
      name: "cli-config",
      absRoot: "/home/box/cli-config",
      relPrefix: "home/box/cli-config",
      excludes: ["home/box/cli-config/.cli-auth-tmp*", "home/box/cli-config/*.cli-auth-old", "home/box/cli-config/**/*.cli-auth-old"],
    },
    {
      name: CHROME_SESSION_CATEGORY_NAME,
      absRoot: CHROME_SESSION_DB_DIR,
      relPrefix: "home/box/chrome-profile",
      stageOnly: true,
      stage: () => stageBoxChromeSession({ retry: args.chromeStageRetry, report: args.reportChromeSessionStage }),
    },
    ...CHROME_AUTH_STATE_REL_DIRS.map((dir) => ({
      name: `chrome-${dir.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      absRoot: `${CHROME_SESSION_DB_DIR}/${dir}`,
      relPrefix: `${CHROME_SESSION_DB_REL_DIR}/${dir}`,
      excludes: CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES.map((cache) => `${CHROME_SESSION_DB_REL_DIR}/${dir}/${cache}`),
    })),
    {
      name: "chrome-profile",
      absRoot: "/home/box/chrome-profile",
      relPrefix: "home/box/chrome-profile",
      // The session databases and auth state have their own categories above; here they would only be carried twice.
      excludes: [
        ...BOX_PERSIST_ARCHIVE_EXCLUDES,
        ...CHROME_SESSION_DB_NAMES.flatMap((name) => ["", "-wal", "-shm", "-journal"].map((suffix) => `${CHROME_SESSION_DB_REL_DIR}/${name}${suffix}`)),
        ...CHROME_AUTH_STATE_REL_DIRS.map((dir) => `${CHROME_SESSION_DB_REL_DIR}/${dir}`),
      ],
      idleOnly: true,
    },
    // The home directory is only carried by a box whose user opted in: it is the one category that is mostly personal.
    ...(args.env[SLATE_STORE_BETTER_CLI_ENV] === "1" && args.env.SLATE_USER_NON_ROOT === "1" ? [buildBoxHomeCategory(BOX_HOME_DIR)] : []),
  ];
}

export function createBoxStoreSyncService(deps: BoxStoreSyncServiceDependencies): DefaultBoxStoreSyncService {
  return new DefaultBoxStoreSyncService(deps);
}
