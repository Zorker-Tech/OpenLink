import type { UserSkill, UserSkillSummary } from '@/lib/user-skill-types'

import { callDesktopAction } from '../api'

export async function createUserSkillAction(
  input: unknown,
): Promise<
  | { ok: true; skill: UserSkill; path: string }
  | { ok: false; error: string }
> {
  return callDesktopAction('skills.create', input)
}

export async function saveUserSkillAction(
  input: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return callDesktopAction('skills.save', input)
}

export async function deleteUserSkillAction(
  input: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  return callDesktopAction('skills.delete', input)
}

export type { UserSkill, UserSkillSummary }
