/** Background scheduling and teardown for an enabled box-store sync. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BoxStoreSync } from "./box-store-sync.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME } from "./box-store-hydration.ts";
import { CHROME_SESSION_DB_DIR, CHROME_SESSION_DB_NAMES } from "./chrome-session-stage.ts";
import { ChromeSessionWatcher, type ChromeSessionWatcherDependencies } from "./chrome-session-watcher.ts";
import { BOX_STORE_CHROME_INTERVAL_MS, BOX_STORE_SYNC_INTERVAL_MS, type BoxStoreSyncServiceDependencies } from "./box-store-sync-service-contracts.ts";
import { BoxStoreSyncServiceReporter } from "./box-store-sync-service-reporter.ts";

export class BoxStoreSyncServiceRuntime {
  private pollHandle: { dispose(): void } | undefined;
  private sessionWatcher: ChromeSessionWatcher | undefined;
  private lastChromeSyncMs: number;
  private started = false;

  constructor(
    private readonly sync: BoxStoreSync | undefined,
    private readonly dependencies: BoxStoreSyncServiceDependencies,
    private readonly reporter: BoxStoreSyncServiceReporter,
    private readonly slateRoot: string,
  ) {
    this.lastChromeSyncMs = dependencies.clock.monotonicNow();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.sync === undefined) {
      this.dependencies.telemetry.reportBoxStoreSyncCycle("warn", { ok: "false", reason: "disabled", phase: "startup" });
      return;
    }

    const readyAfterSweep = this.sync.sweepLeakedTemps()
      .then(removed => {
        if (removed > 0) this.dependencies.log(`swept ${removed} leaked box-store temp file(s)`);
      })
      .catch(error => this.reporter.logFailure("box-store temp sweep failed", error, this.dependencies.log));

    this.pollHandle = this.dependencies.polling.start(async () => {
      await readyAfterSweep;
      await this.runCycle();
    });
    const watcherDependencies: ChromeSessionWatcherDependencies = {
      watchDir: CHROME_SESSION_DB_DIR,
      sessionDbNames: CHROME_SESSION_DB_NAMES,
      debounce: this.dependencies.chromeSessionDebounce,
      onSessionChange: () => {
        void this.sync?.snapshotNow({ chromeSessionOnly: true, waitForInFlight: true })
          .catch(error => this.reporter.logFailure("chrome-session snapshot rejected", error, this.dependencies.log));
      },
      log: this.dependencies.log,
    };
    this.sessionWatcher = this.dependencies.createChromeSessionWatcher?.(watcherDependencies) ?? new ChromeSessionWatcher(watcherDependencies);
    this.sessionWatcher.start();
    this.dependencies.log("box-store sync enabled (snapshot-out only)");
    this.dependencies.telemetry.reportBoxStoreSyncCycle("info", { ok: "true", reason: "enabled", phase: "startup" });
  }

  async dispose(): Promise<void> {
    this.pollHandle?.dispose();
    this.pollHandle = undefined;
    this.sessionWatcher?.stop();
    this.sessionWatcher = undefined;
    await this.sync?.dispose();
  }

  async runCycle(): Promise<void> {
    if (this.sync === undefined) return;
    const idle = this.dependencies.isIdle();
    const monotonicNow = this.dependencies.clock.monotonicNow();
    const handoffPath = join(this.slateRoot, BOX_STORE_HYDRATION_HANDOFF_FILE_NAME);
    const handoffWaiting = this.dependencies.pathExists?.(handoffPath) ?? existsSync(handoffPath);
    const sealHandoff = handoffWaiting && idle;
    const includeIdleOnly = sealHandoff || (idle && monotonicNow - this.lastChromeSyncMs >= BOX_STORE_CHROME_INTERVAL_MS);
    if (includeIdleOnly) this.lastChromeSyncMs = monotonicNow;

    await this.sync.snapshotNow({
      includeIdleOnly,
      includeStoreDbs: idle,
      skipLiveHandleStoreDbs: !sealHandoff,
      includePacks: includeIdleOnly,
    }).catch(error => this.reporter.logFailure("periodic snapshot rejected", error, this.dependencies.log));
  }
}
