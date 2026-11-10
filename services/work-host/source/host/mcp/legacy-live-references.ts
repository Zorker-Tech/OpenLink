import { fetchMarketplaceMcpPlugins } from "../../shared/node/mcp/mcp-marketplace.ts"
import { getPluginSkillsDir, readPluginSkillsCache } from "../skills/plugin-skills-cache.ts"
import { getGlobalWorkflowsDir, GlobalWorkflowLibrary, type GlobalWorkflowRecord } from "../workflows/workflow-library.ts"
import {
  collectMaterializedSkillSourceUrls,
  isLegacyReferenceForMaterializedSource,
  normalizePluginSkillSourceUrl,
  type MaterializedPluginSkill,
  type PluginCatalogEntry,
} from "../../adapters/interop/plugin-marketplace/legacy-skill-reference-adapter.ts"

const LOG_PREFIX = "[slate:plugin-skills]"

export {
  collectMaterializedSkillSourceUrls,
  isLiveReferencePointerBody,
  normalizePluginSkillSourceUrl,
  skillPathTail,
} from "../../adapters/interop/plugin-marketplace/legacy-skill-reference-adapter.ts"
export type { MaterializedPluginSkill, PluginCatalogEntry, PluginSkillCatalogEntry } from "../../adapters/interop/plugin-marketplace/legacy-skill-reference-adapter.ts"

export interface LiveReferenceLibrary {
  list(): readonly Pick<GlobalWorkflowRecord, "id" | "sourceRef" | "body">[]
  remove(id: string): boolean
}

/** Remove only persisted pointer records whose skill now has a local materialized copy. */
export function removeWorkflowLiveReferences(
  slateRootDir: string,
  sourceUrls: readonly string[],
  library: LiveReferenceLibrary = new GlobalWorkflowLibrary(getGlobalWorkflowsDir(slateRootDir)),
): number {
  if (sourceUrls.length === 0) return 0
  const materializedSources = new Set(sourceUrls.map(normalizePluginSkillSourceUrl))
  let retiredCount = 0
  for (const record of library.list()) {
    if (isLegacyReferenceForMaterializedSource(record, materializedSources) && library.remove(record.id)) retiredCount += 1
  }
  return retiredCount
}

export interface LegacyReferenceSweepDeps {
  slateRootDir: string
  auth: { getAccessToken(args: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> }
  backendUrl: string
  fetchMarketplace?(getAccessToken: () => Promise<string | null>, getMachineId: () => Promise<string>): Promise<{ plugins: readonly PluginCatalogEntry[] }>
  log(message: string): void
  removeReferences?: (slateRootDir: string, sourceUrls: readonly string[]) => number
}

/** Refresh the installed plugin catalog and retire only matching historical pointer records. */
export async function sweepLegacyPluginSkillReferences(deps: LegacyReferenceSweepDeps): Promise<number> {
  const materialized = readPluginSkillsCache(getPluginSkillsDir(deps.slateRootDir))?.skills ?? []
  if (materialized.length === 0) return 0

  try {
    const fetchCatalog = deps.fetchMarketplace ?? fetchMarketplaceMcpPlugins
    const listing = await fetchCatalog(
      async () => {
        const accessToken = await deps.auth.getAccessToken({ backendUrl: deps.backendUrl })
        return accessToken.length > 0 ? accessToken : null
      },
      deps.auth.getMachineId,
    )
    const sourceUrls = collectMaterializedSkillSourceUrls(listing.plugins, materialized as readonly MaterializedPluginSkill[])
    const removed = (deps.removeReferences ?? removeWorkflowLiveReferences)(deps.slateRootDir, sourceUrls)
    if (removed > 0) deps.log(`${LOG_PREFIX} retired ${removed} legacy live-reference record(s)`)
    return removed
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    deps.log(`${LOG_PREFIX} legacy live-reference sweep failed: ${reason}`)
    return 0
  }
}
