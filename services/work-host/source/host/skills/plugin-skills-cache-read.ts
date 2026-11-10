import { readFileSync } from "node:fs";

import { getPluginSkillsCachePath } from "./plugin-skills-cache-paths.ts";
import type { PluginAuthBlock, PluginSkillCacheCandidate, PluginSkillsCache } from "./plugin-skills-cache-contracts.ts";
import { applyPluginSkillDefaults, isPluginAuthBlock, isPluginSkillRecord, positiveCacheId } from "./plugin-skills-cache-records.ts";

export function readPluginSkillsCache(cacheDir: string): PluginSkillsCache | null {
  try {
    const document = JSON.parse(readFileSync(getPluginSkillsCachePath(cacheDir), "utf8")) as Record<string, unknown>;
    if (typeof document.fetchedAt !== "number" || !Number.isFinite(document.fetchedAt)) return null;
    if (!Array.isArray(document.skills) || !document.skills.every(isPluginSkillRecord)) return null;

    const skillRows = document.skills as PluginSkillCacheCandidate[];
    const authBlocked = Array.isArray(document.authBlocked) && document.authBlocked.every(isPluginAuthBlock)
      ? document.authBlocked as PluginAuthBlock[]
      : [];
    return {
      fetchedAt: document.fetchedAt,
      currentUserId: positiveCacheId(document.currentUserId),
      skills: skillRows.map(applyPluginSkillDefaults),
      authBlocked,
    };
  } catch {
    return null;
  }
}
