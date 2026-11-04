import type { HydrationEvidence } from "./box-store-hydration-contracts.ts"

export const INCOMPLETE_LEGACY_HYDRATE_REASON = "incomplete_legacy_hydrate"
export const BOX_STORE_HYDRATION_HANDOFF_FILE_NAME = ".box-store-legacy-hydration-complete"
export const BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH = `home/box/slate-data/${BOX_STORE_HYDRATION_HANDOFF_FILE_NAME}`

export function isHydrationHandoffManifestPath(relativePath: string): boolean {
  return relativePath === BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH
    || relativePath.startsWith(`${BOX_STORE_HYDRATION_HANDOFF_MANIFEST_PATH}.`) && relativePath.endsWith(".tmp")
}

function isNonnegativeWholeNumber(value: unknown): value is number {
  return value != null && Number.isInteger(value) && (value as number) >= 0
}

export function isBoxStoreFullyHydrated(evidence?: HydrationEvidence | null): boolean {
  if (evidence?.failures == null || evidence.failures.length !== 0) return false
  if (!isNonnegativeWholeNumber(evidence.manifestEntries)
    || !isNonnegativeWholeNumber(evidence.files)
    || !isNonnegativeWholeNumber(evidence.verified)) return false

  if (evidence.hydrateSource === "legacy") {
    return isNonnegativeWholeNumber(evidence.authoritativeStoreDbEntries)
      && isNonnegativeWholeNumber(evidence.restoredStoreDbEntries)
      && evidence.restoredStoreDbEntries >= evidence.authoritativeStoreDbEntries
  }
  return evidence.files === evidence.manifestEntries && evidence.verified === evidence.manifestEntries
}
