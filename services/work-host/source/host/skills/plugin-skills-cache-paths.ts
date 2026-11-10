import { isAbsolute, join } from "node:path";

import { PLUGIN_SKILLS_CACHE_FILENAME, PLUGIN_SKILLS_DIRNAME } from "./plugin-skills-cache-contracts.ts";

export function getPluginsRootDir(slateRoot: string): string {
  return join(slateRoot, "plugins");
}

export function getPluginSkillsDir(slateRoot: string): string {
  return join(slateRoot, PLUGIN_SKILLS_DIRNAME);
}

export function getPluginSkillsCachePath(cacheDir: string): string {
  return join(cacheDir, PLUGIN_SKILLS_CACHE_FILENAME);
}

export function isSafePluginSkillId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}

export function isAbsolutePluginSkillPath(filePath: string): boolean {
  return isAbsolute(filePath);
}
