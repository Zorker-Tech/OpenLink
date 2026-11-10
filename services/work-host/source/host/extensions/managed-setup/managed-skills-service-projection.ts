import type { ManagedSkill } from "./managed-skills-cache.ts"
import { fetchedManagedSkillToSlateSkill, type FetchedManagedSkill } from "./slate-managed-skills.ts"

export function projectFetchedSkills(fetched: readonly FetchedManagedSkill[]): ManagedSkill[] {
  const skills: ManagedSkill[] = []
  for (const item of fetched) {
    const projected = fetchedManagedSkillToSlateSkill(item)
    if (projected !== null) skills.push(projected)
  }
  return skills
}
