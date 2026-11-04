/** Coordinate host bundle updates, deferred marker reporting, and the shared update watch. */
import type { HostBundleUpdateState } from "./host-bundle-upgrade.ts";
import type { HostUpgradeServiceDependencies, HostUpgradeWatchOptions } from "./host-upgrade-service-contracts.ts";
import { HostUpgradeMarkerForwarder } from "./host-upgrade-marker-forwarder.ts";
import { HostUpgradeUpdateCoordinator } from "./host-upgrade-update-coordinator.ts";
import { HostUpgradeUpdateWatch } from "./host-upgrade-update-watch.ts";

export type { HostUpdateNowResult, HostUpgradeServiceDependencies } from "./host-upgrade-service-contracts.ts";

export class HostUpgradeService {
  readonly updateState: HostBundleUpdateState;
  private readonly updates: HostUpgradeUpdateCoordinator;
  private readonly markerForwarder: HostUpgradeMarkerForwarder;
  private readonly updateWatch: HostUpgradeUpdateWatch;

  constructor(readonly deps: HostUpgradeServiceDependencies) {
    this.updates = new HostUpgradeUpdateCoordinator(deps);
    this.markerForwarder = new HostUpgradeMarkerForwarder(deps, this.updates);
    this.updateWatch = new HostUpgradeUpdateWatch(deps, this.updates);
    this.updateState = this.updates.state;
  }

  get isAutoUpdateEnabled(): boolean {
    return this.deps.isAutoUpdateEnabled;
  }

  resolveHostBundleIdentityVersion(fallbackVersion?: string): Promise<string> {
    return this.updates.resolveHostIdentityVersion(fallbackVersion);
  }

  startMarkerForwardWake(): void {
    this.markerForwarder.startWake();
  }

  activateAfterHostIdentityReady(): void {
    this.markerForwarder.activateAfterIdentityReady();
  }

  startSharedUpdateWatch(options: HostUpgradeWatchOptions): void {
    this.updateWatch.start(options);
  }

  updateHostNow(options: { force?: boolean; includeErrorDetail?: boolean } = {}) {
    return this.updates.updateHostNow(options);
  }

  getVersionState(): { hostVersion: string | null; latestHostVersion: string | null; hostUpdateAvailable: boolean | null } {
    return this.updates.getVersionState();
  }

  async prepareForUpgrade(): Promise<unknown> {
    await this.deps.automations.suspendWakes();
    this.deps.sharing.prepareForUpgrade();
    return this.deps.transcript.quiesceForUpgrade();
  }

  async resumeInterruptedUpgradeTurns(): Promise<void> {
    await this.deps.transcript.resumeInterruptedUpgradeTurns();
  }

  forwardHostUpgradeMarker(): Promise<unknown> {
    return this.markerForwarder.forward();
  }

  dispose(): void {
    this.updateWatch.dispose();
    this.markerForwarder.dispose();
  }
}
