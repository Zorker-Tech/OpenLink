import { HostExtensions } from "../extension-ids.generated.ts"
import { defineHostExtension } from "../host-extensions.ts"
import {
  composeHostUpgradeService,
  type HostUpgradePeerDependencies,
  type HostUpgradeServiceOverrides,
} from "./host-upgrade-extension-composition.ts"

export {
  HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS,
  createMarkerStore,
  hostBundleWatchIntervalMs,
  hostBundleWatchJitterRatio,
  isHostBundleAutoUpdateEnabled,
} from "./host-upgrade-settings.ts"

export function createHostUpgradeExtension(overrides: HostUpgradeServiceOverrides = {}) {
  return defineHostExtension({
    id: HostExtensions.HostUpgrade,
    dependencies: [
      HostExtensions.Automations,
      HostExtensions.CrossUserSharing,
      HostExtensions.Telemetry,
      HostExtensions.Transcript,
    ],
    start(context) {
      const peers: HostUpgradePeerDependencies = {
        automations: context.deps[HostExtensions.Automations] as HostUpgradePeerDependencies["automations"],
        sharing: context.deps[HostExtensions.CrossUserSharing] as HostUpgradePeerDependencies["sharing"],
        telemetry: (context.deps[HostExtensions.Telemetry] as { logs: HostUpgradePeerDependencies["telemetry"] }).logs,
        transcript: context.deps[HostExtensions.Transcript] as HostUpgradePeerDependencies["transcript"],
      }
      const service = composeHostUpgradeService(peers, overrides)
      context.onStop(() => service.dispose())
      service.startMarkerForwardWake()
      return service
    },
  })
}

export const hostUpgradeExtension = createHostUpgradeExtension()
