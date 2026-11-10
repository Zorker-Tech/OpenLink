import {
  describeHostBundleErrorDetail,
  fetchStageAndReportHostBundle,
  isSlateHostUpgradeAvailable,
  type HostBundleUpdateState,
} from "./host-bundle-upgrade.ts";
import type { HostUpgradeServiceDependencies, HostUpdateNowResult } from "./host-upgrade-service-contracts.ts";
import type { HostBundleSource } from "./host-bundle-source.ts";

interface StageRequest {
  readonly source: HostBundleSource;
  readonly localVersion: string | null;
  readonly trigger: string;
  readonly forceNow: boolean;
}

export class HostUpgradeUpdateCoordinator {
  readonly state: HostBundleUpdateState = {
    stagedVersion: null,
    lastFailedVersion: undefined,
    swapRetryAttempts: new Map(),
  };

  private stageInProgress = false;
  private installedVersion: string | null = null;
  private availableVersion: string | null = null;

  constructor(private readonly dependencies: HostUpgradeServiceDependencies) {}

  async resolveHostIdentityVersion(fallbackVersion?: string): Promise<string> {
    const fromDisk = await this.dependencies.readLocalVersion();
    if (fromDisk !== null) this.installedVersion = fromDisk;
    return fromDisk ?? this.installedVersion ?? fallbackVersion ?? "unknown";
  }

  cacheHostIdentity(): void {
    void this.dependencies.readLocalVersion().then((version) => { this.installedVersion = version; });
    void this.dependencies.resolveBundleSource().then((source) => {
      if (source != null) this.availableVersion = source.version;
    }).catch(() => {});
  }

  getVersionState(): { hostVersion: string | null; latestHostVersion: string | null; hostUpdateAvailable: boolean | null } {
    return {
      hostVersion: this.installedVersion,
      latestHostVersion: this.availableVersion,
      hostUpdateAvailable: this.availableVersion === null
        ? null
        : isSlateHostUpgradeAvailable(this.installedVersion, this.availableVersion),
    };
  }

  async updateHostNow(options: { force?: boolean; includeErrorDetail?: boolean } = {}): Promise<HostUpdateNowResult> {
    const forceNow = options.force ?? true;
    const source = await this.dependencies.resolveBundleSource();
    if (source == null) return { started: false, reason: "no-bundle-source" };
    this.availableVersion = source.version;

    const localVersion = await this.dependencies.readLocalVersion();
    this.installedVersion = localVersion;
    if (!isSlateHostUpgradeAvailable(localVersion, source.version)) {
      return { started: false, reason: "already-latest", version: source.version };
    }
    if (await this.dependencies.isVersionSwapVetoed({ version: source.version, localVersion })) {
      return { started: false, reason: "host-version-rolled-back", version: source.version };
    }

    const stageResult = await this.fetchAndStage({
      source,
      localVersion,
      trigger: forceNow ? "manual-update-host" : "manual-update-host-idle",
      forceNow,
    });
    if (!stageResult.ok) {
      const showDetail = options.includeErrorDetail === true && process.env.SLATE_HOST_DEV_ERROR_DETAIL === "1";
      return {
        started: false,
        reason: showDetail
          ? describeHostBundleErrorDetail(stageResult.error, stageResult.phase)
          : String(stageResult.error),
      };
    }
    return { started: true, version: source.version };
  }

  async maybeAutoUpdateHostBundle(): Promise<void> {
    if (!this.dependencies.isAutoUpdateEnabled || this.stageInProgress) return;
    const source = await this.dependencies.resolveBundleSource();
    if (source == null) return;
    this.availableVersion = source.version;

    const localVersion = this.installedVersion ?? await this.dependencies.readLocalVersion();
    this.installedVersion = localVersion;
    if (!isSlateHostUpgradeAvailable(localVersion, source.version)
      || this.state.stagedVersion === source.version
      || await this.dependencies.isVersionSwapVetoed({ version: source.version, localVersion })) return;

    await this.fetchAndStage({ source, localVersion, trigger: "idle-auto-update", forceNow: false });
  }

  private async fetchAndStage(request: StageRequest): Promise<{ ok: true } | { ok: false; error: unknown; phase?: "fetch" | "stage" }> {
    if (this.stageInProgress) return { ok: false, error: new Error("host bundle update already in flight") };
    this.stageInProgress = true;
    try {
      return await fetchStageAndReportHostBundle({
        source: request.source,
        fromVersion: request.localVersion,
        trigger: request.trigger,
        state: this.state,
        stage: async (bytes) => {
          await this.dependencies.stageUpgrade({
            version: request.source.version,
            bytes,
            forceNow: request.forceNow,
            reason: request.trigger,
          });
        },
        reportUpgrade: (metadata) => this.dependencies.telemetry.reportHostUpgrade(metadata),
        log: (level, message) => this.dependencies.log(level, message),
      });
    } finally {
      this.stageInProgress = false;
    }
  }
}
