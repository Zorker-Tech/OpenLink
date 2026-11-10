import {
  hostBundleWatchInitialDelayMs,
  hostBundleWatchNextDelayMs,
} from "./host-bundle-upgrade.ts";
import type { HostUpgradeServiceDependencies, HostUpgradeWatchOptions } from "./host-upgrade-service-contracts.ts";
import type { HostUpgradeUpdateCoordinator } from "./host-upgrade-update-coordinator.ts";

export class HostUpgradeUpdateWatch {
  private started = false;
  private active = false;
  private delayHandle: { dispose(): void } | undefined;
  private runRootUpdateTick: (() => Promise<void>) | undefined;

  constructor(
    private readonly dependencies: HostUpgradeServiceDependencies,
    private readonly updates: HostUpgradeUpdateCoordinator,
  ) {}

  start(options: HostUpgradeWatchOptions): void {
    if (this.started) return;
    this.started = true;
    this.runRootUpdateTick = options.runRootUpdateTick;
    this.updates.cacheHostIdentity();

    const shouldWatch = options.isBoxAutoUpdateEnabled
      || this.dependencies.isAutoUpdateEnabled
      || this.dependencies.isInBox;
    if (!shouldWatch) return;

    this.active = true;
    this.schedule(hostBundleWatchInitialDelayMs(
      this.dependencies.updateWatchIntervalMs,
      this.dependencies.updateWatchJitterRatio,
      this.dependencies.random,
    ));
  }

  dispose(): void {
    this.active = false;
    this.delayHandle?.dispose();
    this.delayHandle = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.active) return;
    if (delayMs === 0) {
      void this.runAndRearm();
      return;
    }

    let primed = false;
    let handle: { dispose(): void } | undefined;
    handle = this.dependencies.createUpdateWatchDelayPolicy(delayMs).start(async () => {
      if (!primed) {
        primed = true;
        return;
      }
      handle?.dispose();
      if (this.delayHandle === handle) this.delayHandle = undefined;
      await this.runAndRearm();
    });
    this.delayHandle = handle;
  }

  private async runAndRearm(): Promise<void> {
    try {
      await this.runRootUpdateTick?.();
      await this.updates.maybeAutoUpdateHostBundle();
    } catch (error) {
      this.dependencies.log("warn", `shared update watch failed: ${String(error)}`);
    } finally {
      if (this.active) {
        this.schedule(hostBundleWatchNextDelayMs(
          this.dependencies.updateWatchIntervalMs,
          this.dependencies.updateWatchJitterRatio,
          this.dependencies.random,
        ));
      }
    }
  }
}
