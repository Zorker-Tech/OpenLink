import { join } from "node:path"

import { MANAGED_SKILL_FILES_DIRNAME, MANAGED_SKILLS_CACHE_FILENAME, MANAGED_SKILLS_DIRNAME } from "./managed-skills-cache-contracts.ts"

export function getManagedSkillsDir(slateRoot: string): string {
  return join(slateRoot, MANAGED_SKILLS_DIRNAME)
}

export function getManagedSkillsCachePath(cacheDir: string): string {
  return join(cacheDir, MANAGED_SKILLS_CACHE_FILENAME)
}

export function getManagedSkillFilePath(cacheDir: string, skillId: string): string {
  return join(cacheDir, MANAGED_SKILL_FILES_DIRNAME, skillId, "SKILL.md")
}
