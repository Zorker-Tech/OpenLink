import 'server-only'

import type { UserSkill, UserSkillSummary } from '@/lib/user-skill-types'
import { createClient } from '@/utils/supabase/server'

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

interface UserSkillRow {
  id: string
  name: string
  slug: string
  content: string
  updated_at: string
}

const summaryColumns = 'id, name, slug, updated_at'
const detailColumns = `${summaryColumns}, content`

function toSummary(row: Omit<UserSkillRow, 'content'>): UserSkillSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    updatedAt: row.updated_at,
  }
}

function toSkill(row: UserSkillRow): UserSkill {
  return { ...toSummary(row), content: row.content }
}

export function slugifySkillName(name: string) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'skill'
}

export function createSkillTemplate(name: string) {
  const safeName = slugifySkillName(name)
  return `---\nname: ${safeName}\ndescription: Describe when this skill should be used.\n---\n\n# ${name.trim()}\n\nAdd concise instructions for the agent here.\n`
}

export async function listUserSkills(supabase: ServerSupabaseClient, userId: string) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('user_skills')
    .select(summaryColumns)
    .eq('user_id', userId)
    .order('name', { ascending: true })

  if (error) throw error
  return ((data ?? []) as unknown as Array<Omit<UserSkillRow, 'content'>>).map(toSummary)
}

export async function getUserSkill(supabase: ServerSupabaseClient, userId: string, skillId: string) {
  const { data, error } = await supabase
    .schema('openlink')
    .from('user_skills')
    .select(detailColumns)
    .eq('user_id', userId)
    .eq('id', skillId)
    .maybeSingle()

  if (error) throw error
  return data ? toSkill(data as unknown as UserSkillRow) : null
}

export async function createUserSkill(
  supabase: ServerSupabaseClient,
  userId: string,
  input: { name: string; content?: string },
) {
  const name = input.name.trim()
  const baseSlug = slugifySkillName(name)

  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate = suffix === 1 ? baseSlug : `${baseSlug.slice(0, 60)}-${suffix}`
    const { data, error } = await supabase
      .schema('openlink')
      .from('user_skills')
      .insert({
        user_id: userId,
        name,
        slug: candidate,
        content: input.content ?? createSkillTemplate(name),
      })
      .select(detailColumns)
      .single()

    if (!error) return toSkill(data as unknown as UserSkillRow)
    if (error.code !== '23505') throw error
  }

  throw new Error('SKILL_NAME_CONFLICT')
}
