import { noteFailedSwapMarkerForRetry } from "./host-bundle-upgrade.ts";
import { forwardHostUpgradeMarkerWith } from "./host-upgrade-marker.ts";
import type { HostUpgradeServiceDependencies, HostUpgradeDisposable } from "./host-upgrade-service-contracts.ts";
import type { HostUpgradeUpdateCoordinator } from "./host-upgrade-update-coordinator.ts";

interface MarkerForwardMoment {
  readonly raw: string;
  readonly timestampMs: number;
}

export class HostUpgradeMarkerForwarder {
  private wakeHandle: HostUpgradeDisposable | undefined;
  private forwarding = false;
  private identityReady = false;
  private lastMoment: MarkerForwardMoment | undefined;
  private lastForwardedRaw: string | undefined;

  constructor(
    private readonly dependencies: HostUpgradeServiceDependencies,
    private readonly updates: HostUpgradeUpdateCoordinator,
  ) {}

  startWake(): void {
    if (this.wakeHandle != null) return;
    this.wakeHandle = this.dependencies.markerForwardPolicy.start(async () => {
      if (this.identityReady) await this.forward();
    });
  }

  activateAfterIdentityReady(): void {
    if (this.identityReady) return;
    this.identityReady = true;
    void this.forward();
  }

  async forward(): Promise<unknown> {
    if (this.forwarding) return undefined;
    this.forwarding = true;
    try {
      return await forwardHostUpgradeMarkerWith({
        readRaw: () => this.dependencies.markerStore.readRaw(),
        deleteMarker: () => this.dependencies.markerStore.deleteMarker(),
        emit: (metadata) => this.dependencies.telemetry.reportHostUpgradeConfirmed(metadata),
        warn: (message) => this.dependencies.log("warn", message),
        now: (raw) => this.timestampFor(raw),
        wasForwarded: (raw) => raw === this.lastForwardedRaw,
        markForwarded: (raw) => { this.lastForwardedRaw = raw; },
        onForwarded: (marker) => {
          if (noteFailedSwapMarkerForRetry(this.updates.state, marker)) {
            this.dependencies.log(
              "info",
              `supervisor swap of ${marker.toVersion ?? "?"} failed (${marker.swapError ?? "swap-failed"}); re-staging on the next idle watch tick`,
            );
          }
        },
      });
    } finally {
      this.forwarding = false;
    }
  }

  dispose(): void {
    this.wakeHandle?.dispose();
    this.wakeHandle = undefined;
  }

  private timestampFor(raw: string): number {
    if (this.lastMoment?.raw !== raw) {
      this.lastMoment = { raw, timestampMs: this.dependencies.clock.now() };
    }
    return this.lastMoment.timestampMs;
  }
}
