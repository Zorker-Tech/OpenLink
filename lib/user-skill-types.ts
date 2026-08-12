export interface UserSkillSummary {
  id: string
  name: string
  slug: string
  updatedAt: string
}

export interface UserSkill extends UserSkillSummary {
  content: string
}
