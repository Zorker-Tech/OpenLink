export const MANAGED_SKILLS_DIRNAME = "managed-skills"
export const MANAGED_SKILLS_CACHE_FILENAME = "cache.json"
export const MANAGED_SKILL_FILES_DIRNAME = "skills"

export interface ManagedSkill {
  id: string
  name: string
  description: string
  body: string
}

export interface ManagedSkillsCache {
  fetchedAt: number
  skills: ManagedSkill[]
}

export function isManagedSkill(value: unknown): value is ManagedSkill {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string"
    && row.id.length > 0
    && typeof row.name === "string"
    && typeof row.description === "string"
    && typeof row.body === "string"
    && row.body.length > 0
}
