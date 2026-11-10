/** Shared configuration and API shapes for the box-store host service. */
import type { Clock, DebouncePolicy, PollingPolicy, RetryPolicy } from "../../extensions/scheduling.ts";
import type { AgentStoreClientDependencies } from "./agent-store-slate-files.ts";
import type { BoxObjectStoreProvider } from "./box-object-store.ts";
import type { ChromeSessionWatcher, ChromeSessionWatcherDependencies } from "./chrome-session-watcher.ts";
import type { BoxStoreCaptureSummary, BoxStoreCategory, BoxStoreCycleSummary, BoxStoreSync, BoxStoreSyncDependencies } from "./box-store-sync.ts";

export const SLATE_STORE_BETTER_CLI_ENV = "SLATE_STORE_BETTER_CLI";
export const BOX_HOME_CATEGORY_NAME = "home";
export const BOX_HOME_DIR = "/home/box";
export const BOX_HOME_REL_PREFIX = "home/box";
export const BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES = [
  `${BOX_HOME_REL_PREFIX}/cli-config`,
  `${BOX_HOME_REL_PREFIX}/chrome-profile*`,
  `${BOX_HOME_REL_PREFIX}/slate-data`,
  `${BOX_HOME_REL_PREFIX}/slate-host`,
  `${BOX_HOME_REL_PREFIX}/deps`,
] as const;
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
  slateRootDir?: string;
  pathExists?: (path: string) => boolean;
  createStoreSync?: (dependencies: BoxStoreSyncDependencies) => BoxStoreSync;
  createChromeSessionWatcher?: (dependencies: ChromeSessionWatcherDependencies) => ChromeSessionWatcher;
  objectStoreProvider?: BoxObjectStoreProvider;
}

export interface BoxStoreSyncApi {
  isEnabled: boolean;
  objectStoreProvider: BoxObjectStoreProvider;
  getStoreId(): Promise<string>;
  snapshotBoxStoreNow(args: { includeIdleOnly?: boolean }): Promise<ReturnType<typeof import("./box-store-sync-observability.ts").evaluateBoxStoreFlush>>;
  getBoxStoreStatus(): ReturnType<BoxStoreSync["readStoreStatus"]>;
  clearBoxStoreNow(): Promise<{ ok: boolean; reason?: string }>;
  scheduleStoreDbSnapshot(agentId: string): void;
  forgetAgent(agentId: string): Promise<void>;
}

export interface BuildBoxStoreCategoriesArgs {
  slateRoot: string;
  chromeStageRetry: RetryPolicy;
  reportChromeSessionStage(outcome: import("./chrome-session-stage.ts").ChromeStageReport): void;
  env: NodeJS.ProcessEnv;
}

export type { BoxStoreCaptureSummary, BoxStoreCategory, BoxStoreCycleSummary };
