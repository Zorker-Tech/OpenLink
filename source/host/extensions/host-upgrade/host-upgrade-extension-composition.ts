import { createRealPollingPolicy, realClock } from "../scheduling.ts"
import { HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS, createMarkerStore, hostBundleWatchIntervalMs, hostBundleWatchJitterRatio, isHostBundleAutoUpdateEnabled } from "./host-upgrade-settings.ts"
import { resolveHostBundleSource } from "./host-bundle-source.ts"
import { isHostVersionSwapVetoed, readLocalHostVersion, stageHostBundleUpgrade } from "./host-bundle-upgrade.ts"
import { HostUpgradeService, type HostUpgradeServiceDependencies } from "./host-upgrade-service.ts"

type HostUpgradePeerDependencies = Pick<
  HostUpgradeServiceDependencies,
  "automations" | "sharing" | "telemetry" | "transcript"
>

export type HostUpgradeServiceOverrides = Partial<
  Omit<HostUpgradeServiceDependencies, keyof HostUpgradePeerDependencies>
>

export function composeHostUpgradeService(
  peers: HostUpgradePeerDependencies,
  overrides: HostUpgradeServiceOverrides = {},
): HostUpgradeService {
  return new HostUpgradeService({
    ...peers,
    markerStore: createMarkerStore(),
    markerForwardPolicy: createRealPollingPolicy({
      name: "host-upgrade-marker-forward",
      intervalMs: HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS,
    }),
    createUpdateWatchDelayPolicy: delayMs => createRealPollingPolicy({
      name: "host-upgrade-shared-update-watch",
      intervalMs: delayMs,
    }),
    clock: realClock,
    random: Math.random,
    isInBox: process.env.SLATE_HOST_IN_BOX === "1",
    isAutoUpdateEnabled: isHostBundleAutoUpdateEnabled(),
    updateWatchIntervalMs: hostBundleWatchIntervalMs(),
    updateWatchJitterRatio: hostBundleWatchJitterRatio(),
    resolveBundleSource: resolveHostBundleSource,
    readLocalVersion: readLocalHostVersion,
    isVersionSwapVetoed: isHostVersionSwapVetoed,
    stageUpgrade: stageHostBundleUpgrade,
    log: (level, message) => {
      const write = level === "warn" ? console.warn : console.info
      write("[slate-host] " + message)
    },
    ...overrides,
  })
}

export type { HostUpgradePeerDependencies }
