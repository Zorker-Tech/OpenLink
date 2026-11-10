import { isAbsolutePluginSkillPath, isSafePluginSkillId } from "./plugin-skills-cache-paths.ts";
import type { PluginAuthBlock, PluginSkillCacheCandidate, PluginSkillRecord } from "./plugin-skills-cache-contracts.ts";

export function isPluginSkillRecord(value: unknown): value is PluginSkillCacheCandidate {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.id === "string"
    && isSafePluginSkillId(fields.id)
    && typeof fields.pluginId === "string"
    && fields.pluginId.length > 0
    && typeof fields.pluginName === "string"
    && typeof fields.name === "string"
    && fields.name.length > 0
    && typeof fields.description === "string"
    && typeof fields.filePath === "string"
    && isAbsolutePluginSkillPath(fields.filePath);
}

export function isPluginAuthBlock(value: unknown): value is PluginAuthBlock {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.pluginId === "string"
    && typeof fields.pluginName === "string"
    && (fields.marketplaceName === undefined || typeof fields.marketplaceName === "string");
}

export function positiveCacheId(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

export function applyPluginSkillDefaults(candidate: PluginSkillCacheCandidate): PluginSkillRecord {
  return {
    ...candidate,
    pluginVersion: typeof candidate.pluginVersion === "string" ? candidate.pluginVersion : "",
    installPath: typeof candidate.installPath === "string" && isAbsolutePluginSkillPath(candidate.installPath)
      ? candidate.installPath
      : "",
    skillRelativePath: typeof candidate.skillRelativePath === "string" ? candidate.skillRelativePath : "",
    publisherUserId: positiveCacheId(candidate.publisherUserId),
    marketplaceTeamId: positiveCacheId(candidate.marketplaceTeamId),
  };
}
