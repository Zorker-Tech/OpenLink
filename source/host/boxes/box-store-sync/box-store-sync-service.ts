/** Host-facing box-store service; lifecycle, storage access and telemetry have their own modules. */
import { join } from "node:path";
import { getBoxStoreBackendPolicy, isBoxStoreSyncEnabled } from "../box-store-backend-policy.ts";
import { getSlateRootDir } from "../../host-paths.ts";
import { resolveBoxObjectStoreProvider, type BoxObjectStoreProvider } from "./box-object-store.ts";
import { BoxStoreSync, type BoxStoreSyncDependencies } from "./box-store-sync.ts";
import { SLATE_MANIFEST_V2_ENV } from "./box-store-manifest-format.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME } from "./box-store-hydration.ts";
import { buildBoxStoreCategories, buildBoxHomeCategory } from "./box-store-sync-service-categories.ts";
import { createBoxStoreSyncApi } from "./box-store-sync-service-api.ts";
import { BoxStoreSyncServiceReporter } from "./box-store-sync-service-reporter.ts";
import { BoxStoreSyncServiceRuntime } from "./box-store-sync-service-runtime.ts";
import { BoxStoreSyncServiceStore } from "./box-store-sync-service-store.ts";
import type { BoxStoreCategory } from "./box-store-sync-contracts.ts";
import type { BoxStoreBackendPolicy } from "../box-store-backend-policy.ts";
import {
  BOX_HOME_CATEGORY_NAME,
  BOX_HOME_DIR,
  BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
  BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS,
  BOX_HOME_REL_PREFIX,
  BOX_STORE_CHROME_INTERVAL_MS,
  BOX_STORE_DB_DEBOUNCE_MS,
  BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  CHROME_SESSION_CHANGE_DEBOUNCE_MS,
  SLATE_STORE_BETTER_CLI_ENV,
  type BoxStoreSyncApi,
  type BoxStoreSyncServiceDependencies,
  type BoxStoreTelemetry,
} from "./box-store-sync-service-contracts.ts";

export {
  BOX_HOME_CATEGORY_NAME,
  BOX_HOME_DIR,
  BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
  BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS,
  BOX_HOME_REL_PREFIX,
  BOX_STORE_CHROME_INTERVAL_MS,
  BOX_STORE_DB_DEBOUNCE_MS,
  BOX_STORE_MANIFEST_RETRY_ATTEMPTS,
  BOX_STORE_MANIFEST_RETRY_DELAY_MS,
  BOX_STORE_SYNC_INTERVAL_MS,
  CHROME_SESSION_CHANGE_DEBOUNCE_MS,
  SLATE_STORE_BETTER_CLI_ENV,
  buildBoxHomeCategory,
  buildBoxStoreCategories,
};
export type { BoxStoreSyncApi, BoxStoreSyncServiceDependencies, BoxStoreTelemetry };

export class DefaultBoxStoreSyncService {
  readonly api: BoxStoreSyncApi;
  readonly env: NodeJS.ProcessEnv;
  readonly slateRoot: string;
  readonly backendPolicy: BoxStoreBackendPolicy;
  readonly sync: BoxStoreSync | undefined;
  private readonly reporter: BoxStoreSyncServiceReporter;
  private readonly store: BoxStoreSyncServiceStore;
  private readonly runtime: BoxStoreSyncServiceRuntime;

  constructor(readonly deps: BoxStoreSyncServiceDependencies) {
    this.env = deps.env ?? process.env;
    this.slateRoot = deps.slateRootDir ?? getSlateRootDir();
    this.backendPolicy = getBoxStoreBackendPolicy(this.env);
    const objectStoreProvider = deps.objectStoreProvider ?? resolveBoxObjectStoreProvider({ env: this.env, agentStore: deps.auth });
    const enabled = isBoxStoreSyncEnabled(this.env);
    this.reporter = new BoxStoreSyncServiceReporter(deps.telemetry);

    this.sync = enabled
      ? this.createSync(this.categories(), objectStoreProvider, "[box-store-sync]")
      : undefined;
    this.store = new BoxStoreSyncServiceStore(
      deps,
      this.env,
      this.backendPolicy,
      objectStoreProvider,
      this.sync,
      (categories, provider, prefix) => this.createSync(categories, provider, prefix),
    );
    this.runtime = new BoxStoreSyncServiceRuntime(this.sync, deps, this.reporter, this.slateRoot);

    this.api = createBoxStoreSyncApi({ enabled, provider: objectStoreProvider, store: this.store });
  }

  start(): void {
    this.runtime.start();
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
    await this.store.disposeAccessor();
  }

  runCycle(): Promise<void> {
    return this.runtime.runCycle();
  }

  private categories(): BoxStoreCategory[] {
    return buildBoxStoreCategories({
      slateRoot: this.slateRoot,
      chromeStageRetry: this.deps.chromeStageRetry,
      reportChromeSessionStage: outcome => this.reporter.chromeSessionStage(outcome),
      env: this.env,
    });
  }

  private createSync(categories: readonly BoxStoreCategory[], objectStoreProvider: BoxObjectStoreProvider, logPrefix: string): BoxStoreSync {
    const dependencies: BoxStoreSyncDependencies = {
      resolveStoreId: () => this.store.getStoreId(),
      categories,
      objectStoreProvider,
      manifestV2: this.env[SLATE_MANIFEST_V2_ENV] === "1",
      hydrationHandoffMarkerPath: join(this.slateRoot, BOX_STORE_HYDRATION_HANDOFF_FILE_NAME),
      storeDbDebounce: this.deps.storeDbDebounce,
      manifestRetry: this.deps.manifestRetry,
      now: () => this.deps.clock.now(),
      log: message => this.deps.log(`${logPrefix} ${message}`),
      ...(categories.length === 0
        ? {}
        : {
            lockPath: join(this.slateRoot, "box-store-sync.lock"),
            windowId: `slate-host-${process.pid}`,
            onCycle: (summary: import("./box-store-sync-contracts.ts").BoxStoreCycleSummary) => this.reporter.storeCycle(summary),
            onStoreDbCapture: (summary: import("./box-store-sync-contracts.ts").BoxStoreCaptureSummary) => this.reporter.storeDbCapture(summary),
            onManifestWriteConflict: (info: Record<string, unknown>) => this.reporter.manifestConflict(info),
          }),
    };
    return this.deps.createStoreSync?.(dependencies) ?? new BoxStoreSync(dependencies);
  }
}

export function createBoxStoreSyncService(deps: BoxStoreSyncServiceDependencies): DefaultBoxStoreSyncService {
  return new DefaultBoxStoreSyncService(deps);
}
