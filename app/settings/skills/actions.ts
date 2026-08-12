'use server'

import { createUserSkill } from '@/lib/user-skills.server'
import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

const skillName = z.string().trim().min(1).max(64)
const skillId = z.string().uuid()
const skillContent = z.string().max(200_000)

async function authenticatedClient() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('AUTH_REQUIRED')
  return { supabase, user }
}

export async function createUserSkillAction(input: unknown) {
  const parsed = z.object({ name: skillName, content: skillContent.optional() }).safeParse(input)
  if (!parsed.success) return { ok: false as const, error: 'INVALID_SKILL' }

  try {
    const { supabase, user } = await authenticatedClient()
    const skill = await createUserSkill(supabase, user.id, parsed.data)
    revalidatePath('/settings/skills')
    return { ok: true as const, skill, path: `/settings/skills/${skill.id}` }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'SKILL_CREATE_FAILED' }
  }
}

export async function saveUserSkillAction(input: unknown) {
  const parsed = z.object({ skillId, content: skillContent }).safeParse(input)
  if (!parsed.success) return { ok: false as const, error: 'INVALID_SKILL' }

  try {
    const { supabase, user } = await authenticatedClient()
    const { data, error } = await supabase
      .schema('openlink')
      .from('user_skills')
      .update({ content: parsed.data.content, updated_at: new Date().toISOString() })
      .eq('id', parsed.data.skillId)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new Error('SKILL_NOT_FOUND')
    revalidatePath('/settings/skills')
    revalidatePath(`/settings/skills/${parsed.data.skillId}`)
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'SKILL_SAVE_FAILED' }
  }
}

export async function deleteUserSkillAction(input: unknown) {
  const parsed = skillId.safeParse(input)
  if (!parsed.success) return { ok: false as const, error: 'INVALID_SKILL' }

  try {
    const { supabase, user } = await authenticatedClient()
    const { error } = await supabase
      .schema('openlink')
      .from('user_skills')
      .delete()
      .eq('id', parsed.data)
      .eq('user_id', user.id)
    if (error) throw error
    revalidatePath('/settings/skills')
    return { ok: true as const, path: '/settings/skills' }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'SKILL_DELETE_FAILED' }
  }
}
