export const PLUGIN_SKILLS_DIRNAME = "plugin-skills";
export const PLUGIN_SKILLS_CACHE_FILENAME = "cache.json";

export interface PluginSkillRecord {
  id: string;
  pluginId: string;
  pluginName: string;
  name: string;
  description: string;
  filePath: string;
  pluginVersion: string;
  installPath: string;
  skillRelativePath: string;
  publisherUserId: number | null;
  marketplaceTeamId: number | null;
}

export interface PluginAuthBlock {
  pluginId: string;
  pluginName: string;
  marketplaceName?: string;
}

export interface PluginSkillsCache {
  fetchedAt: number;
  currentUserId: number | null;
  skills: PluginSkillRecord[];
  authBlocked: PluginAuthBlock[];
}

export type PluginSkillRecordBase = Pick<PluginSkillRecord,
  "id" | "pluginId" | "pluginName" | "name" | "description" | "filePath"
>;

export type PluginSkillCacheCandidate = PluginSkillRecordBase & Partial<PluginSkillRecord>;
