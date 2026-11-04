import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import type { HostUpgradeServiceDependencies } from "./host-upgrade-service.ts"
import { HOST_BUNDLE_WATCH_INTERVAL_MS, HOST_BUNDLE_WATCH_JITTER_RATIO } from "./host-bundle-upgrade.ts"
import { getHostUpgradeMarkerPath } from "../../host-paths.ts"

export const HOST_UPGRADE_MARKER_FORWARD_INTERVAL_MS = 5 * 60_000

export function isHostBundleAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const setting = env.SLATE_BOX_AUTO_UPDATE?.trim().toLowerCase()
  return setting !== "0" && setting !== "false" && setting !== "no"
}

export function hostBundleWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const interval = Number.parseInt(env.SLATE_BOX_UPDATE_WATCH_INTERVAL_MS ?? "", 10)
  return Number.isInteger(interval) && interval > 0 ? interval : HOST_BUNDLE_WATCH_INTERVAL_MS
}

export function hostBundleWatchJitterRatio(env: NodeJS.ProcessEnv = process.env): number {
  const ratio = Number.parseFloat(env.SLATE_BOX_UPDATE_WATCH_JITTER_RATIO ?? "")
  return Number.isFinite(ratio) && ratio >= 0 ? ratio : HOST_BUNDLE_WATCH_JITTER_RATIO
}

export function createMarkerStore(
  markerPath = getHostUpgradeMarkerPath(),
): HostUpgradeServiceDependencies["markerStore"] {
  return {
    async readRaw() {
      try {
        return existsSync(markerPath) ? await readFile(markerPath, "utf8") : null
      } catch {
        return null
      }
    },
    async deleteMarker() {
      try {
        await rm(markerPath, { force: true })
      } catch {}
    },
  }
}
