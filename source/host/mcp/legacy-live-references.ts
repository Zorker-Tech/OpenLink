/**
 * The live references to plugin skills that are no longer live.
 *
 * A skill that came from a plugin used to be left in the library as a pointer to where it came from. Now that those
 * skills are materialized — the real file, kept where the plugin lives — a pointer whose skill really is materialized
 * is retired, and only that: a pointer to a skill nobody installed stays exactly where it is.
 */

import { fetchMarketplaceMcpPlugins } from "../../shared/node/mcp/mcp-marketplace.ts";
import { getPluginSkillsDir, readPluginSkillsCache } from "../skills/plugin-skills-cache.ts";
import { getGlobalWorkflowsDir, GlobalWorkflowLibrary, type GlobalWorkflowRecord } from "../workflows/workflow-library.ts";

export interface PluginSkillCatalogEntry {
  sourceUrl?: string | null;
}

export interface PluginCatalogEntry {
  pluginId: string;
  skills: readonly PluginSkillCatalogEntry[];
}

export interface MaterializedPluginSkill {
  pluginId: string;
  filePath: string;
}

const LIVE_REFERENCE_MARKER = "is a live reference to the skill at";
const LOG_PREFIX = "[slate:plugin-skills]";

/** Whether a library body is a pointer to a skill rather than the skill itself. */
export function isLiveReferencePointerBody(body: string): boolean {
  return body.includes(LIVE_REFERENCE_MARKER);
}

/**
 * Where a skill's source is, as a reference is compared: the host and path of a github blob link, without the ref it
 * was read at — the same skill at another revision is the same skill.
 */
export function normalizePluginSkillSourceUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const [owner, repo, marker, ref, ...path] = segments;
  if (owner == null || repo == null || marker !== "blob" || ref == null || path.length === 0) return raw;
  return `${parsed.hostname.toLowerCase()}/${owner}/${repo}/${path.join("/")}`;
}

/** Where a skill sits under its plugin's skills root, as a path the two sides can be compared by. */
export function skillPathTail(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/skills/");
  return index === -1 ? null : normalized.slice(index + 1);
}

/** The source urls of the catalog's skills that this machine has already materialized. */
export function collectMaterializedSkillSourceUrls(catalog: readonly PluginCatalogEntry[], records: readonly MaterializedPluginSkill[]): string[] {
  const materialized = new Set(
    records.flatMap((record) => {
      const tail = skillPathTail(record.filePath);
      return tail == null ? [] : [`${record.pluginId}\0${tail}`];
    }),
  );
  return catalog.flatMap((plugin) =>
    plugin.skills.flatMap((skill) => {
      if (skill.sourceUrl == null) return [];
      const tail = skillPathTail(skill.sourceUrl);
      return tail != null && materialized.has(`${plugin.pluginId}\0${tail}`) ? [skill.sourceUrl] : [];
    }),
  );
}

export interface LiveReferenceLibrary {
  list(): readonly Pick<GlobalWorkflowRecord, "id" | "sourceRef" | "body">[];
  remove(id: string): boolean;
}

/** Retires the library's pointers to the given sources, and answers how many it retired. */
export function removeWorkflowLiveReferences(
  slateRootDir: string,
  sourceUrls: readonly string[],
  library: LiveReferenceLibrary = new GlobalWorkflowLibrary(getGlobalWorkflowsDir(slateRootDir)),
): number {
  if (sourceUrls.length === 0) return 0;
  const retired = new Set(sourceUrls.map(normalizePluginSkillSourceUrl));
  let removed = 0;
  for (const record of library.list()) {
    // Only a pointer that is still a pointer, and only to a skill that was materialized: anything else is the user's.
    if (record.sourceRef != null && retired.has(normalizePluginSkillSourceUrl(record.sourceRef)) && isLiveReferencePointerBody(record.body) && library.remove(record.id)) removed += 1;
  }
  return removed;
}

export interface LegacyReferenceSweepDeps {
  slateRootDir: string;
  auth: { getAccessToken(args: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string> };
  backendUrl: string;
  fetchMarketplace?(getAccessToken: () => Promise<string | null>, getMachineId: () => Promise<string>): Promise<{ plugins: readonly PluginCatalogEntry[] }>;
  log(message: string): void;
  removeReferences?: (slateRootDir: string, sourceUrls: readonly string[]) => number;
}

/** Retires the pointers to skills that this machine has since materialized, and never fails the caller over it. */
export async function sweepLegacyPluginSkillReferences(deps: LegacyReferenceSweepDeps): Promise<number> {
  const records = readPluginSkillsCache(getPluginSkillsDir(deps.slateRootDir))?.skills ?? [];
  // With no plugin skills installed there is nothing that could have been materialized.
  if (records.length === 0) return 0;
  try {
    const fetchMarketplace = deps.fetchMarketplace ?? fetchMarketplaceMcpPlugins;
    const { plugins } = await fetchMarketplace(
      async () => {
        const token = await deps.auth.getAccessToken({ backendUrl: deps.backendUrl });
        return token.length > 0 ? token : null;
      },
      deps.auth.getMachineId,
    );
    const removed = (deps.removeReferences ?? removeWorkflowLiveReferences)(deps.slateRootDir, collectMaterializedSkillSourceUrls(plugins, records));
    if (removed > 0) deps.log(`${LOG_PREFIX} retired ${removed} legacy live-reference record(s)`);
    return removed;
  } catch (error) {
    // A sweep that could not run is reported and answered as nothing retired: it is housekeeping, not a turn.
    deps.log(`${LOG_PREFIX} legacy live-reference sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
