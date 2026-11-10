/** Choose the source that can safely repopulate a box before its host starts. */

import { errorMessage } from "../../../shared/errors/summary.ts"
import { countStoreDbManifestEntries, getStoreDbManifestAgentIds, type BoxManifestMap } from "./box-store-manifest.ts"
import { INCOMPLETE_LEGACY_HYDRATE_REASON } from "./box-store-hydration.ts"
import { copyInFailureResult, emptyCopyInResult, type CopyInResult, type CopyInSync } from "./copy-in-contracts.ts"

export interface CopyInSourceResolutionInput {
  readonly sync: CopyInSync
  readonly legacySync?: CopyInSync
  readonly log: (message: string) => void
}

export interface CopyInRestorePlan {
  readonly kind: "restore"
  readonly downloadFrom: CopyInSync
  readonly manifest: BoxManifestMap
  readonly hydrateSource?: "legacy"
  readonly downloadViaLegacy: boolean
  readonly advertisedStoreDbEntries?: number
  readonly requiredStoreDbAgentIds?: Set<string>
}

export type CopyInSourceResolution = CopyInRestorePlan | { readonly kind: "finished"; readonly result: CopyInResult }

export async function chooseCopyInRestorePlan(input: CopyInSourceResolutionInput): Promise<CopyInSourceResolution> {
  let primary: Awaited<ReturnType<CopyInSync["readManifestStrictDetailed"]>>
  try {
    primary = await input.sync.readManifestStrictDetailed()
  } catch (error) {
    return { kind: "finished", result: copyInFailureResult({
      message: `store manifest unreadable: ${errorMessage(error)}`,
      issues: [errorMessage(error)],
      indexedEntries: 0,
      storeDatabases: 0,
    }) }
  }

  if ((!primary.present || primary.fullyHydrated === false) && input.legacySync !== undefined) {
    let legacyManifest: BoxManifestMap
    try {
      legacyManifest = await input.legacySync.readManifestStrict()
    } catch (error) {
      return { kind: "finished", result: copyInFailureResult({
        message: `legacy store manifest unreadable: ${errorMessage(error)}`,
        issues: [errorMessage(error)],
        indexedEntries: 0,
        storeDatabases: 0,
        origin: "legacy",
      }) }
    }

    if (legacyManifest.size > 0) {
      if (input.legacySync.manifestV2Enabled === true) input.sync.enrollManifestV2?.()
      const requiredStoreDbAgentIds = getStoreDbManifestAgentIds(legacyManifest)
      const advertisedStoreDbEntries = countStoreDbManifestEntries(legacyManifest)

      if (primary.fullyHydrated === false && primary.manifest.size > 0) {
        if (requiredStoreDbAgentIds.size === 0) {
          return { kind: "finished", result: copyInFailureResult({
            message: `${INCOMPLETE_LEGACY_HYDRATE_REASON} the legacy source has no store.db identities to validate the newer store`,
            issues: ["the legacy source's store.db identity set is empty"],
            indexedEntries: primary.manifest.size,
            restoredStoreDatabases: 0,
            storeDatabases: 0,
            origin: "legacy",
          }) }
        }

        const primaryStoreDbAgentIds = getStoreDbManifestAgentIds(primary.manifest)
        const restoredStoreDbEntries = [...requiredStoreDbAgentIds].filter(agentId => primaryStoreDbAgentIds.has(agentId)).length
        const primaryCoversLegacyAgents = restoredStoreDbEntries === requiredStoreDbAgentIds.size
        if (!primaryCoversLegacyAgents) {
          return { kind: "finished", result: copyInFailureResult({
            message: `${INCOMPLETE_LEGACY_HYDRATE_REASON} the newer store's store.db coverage is below the legacy source`,
            issues: ["incomplete store.db agent coverage in the newer store"],
            indexedEntries: primary.manifest.size,
            storeDatabases: advertisedStoreDbEntries,
            restoredStoreDatabases: restoredStoreDbEntries,
            origin: "legacy",
          }) }
        }

        input.log(`the newer store's manifest is not sealed but covers all ${advertisedStoreDbEntries} legacy store.db entries; hydrating the newer store`)
        return {
          kind: "restore",
          downloadFrom: input.sync,
          manifest: primary.manifest,
          hydrateSource: "legacy",
          downloadViaLegacy: false,
          advertisedStoreDbEntries,
          requiredStoreDbAgentIds,
        }
      }

      input.log(`this box's store was never seeded; hydrating ${legacyManifest.size} entries from the legacy store`)
      return {
        kind: "restore",
        downloadFrom: input.legacySync,
        manifest: legacyManifest,
        hydrateSource: "legacy",
        downloadViaLegacy: true,
        advertisedStoreDbEntries,
        requiredStoreDbAgentIds,
      }
    }

    if (primary.fullyHydrated === false) {
      return { kind: "finished", result: copyInFailureResult({
        message: "the legacy source's manifest is empty while the newer store is incomplete",
        issues: ["the legacy source's manifest is empty"],
        indexedEntries: primary.manifest.size,
        storeDatabases: countStoreDbManifestEntries(primary.manifest),
        restoredStoreDatabases: 0,
        origin: "legacy",
      }) }
    }
  }

  if (primary.manifest.size === 0) {
    return { kind: "finished", result: emptyCopyInResult("the store is empty; this is a first boot") }
  }

  return {
    kind: "restore",
    downloadFrom: input.sync,
    manifest: primary.manifest,
    downloadViaLegacy: false,
  }
}
