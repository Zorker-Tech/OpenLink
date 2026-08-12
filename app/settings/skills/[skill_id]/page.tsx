import { SkillsWorkspace } from '@/components/settings/skills-workspace'
import { getUserSkill, listUserSkills } from '@/lib/user-skills.server'
import { createClient } from '@/utils/supabase/server'
import { notFound, redirect } from 'next/navigation'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default async function SkillEditorPage({ params }: { params: Promise<{ skill_id: string }> }) {
  const { skill_id: skillId } = await params
  if (!uuidPattern.test(skillId)) notFound()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/settings/skills/${skillId}`)}`)
  const [skills, currentSkill] = await Promise.all([
    listUserSkills(supabase, user.id),
    getUserSkill(supabase, user.id, skillId),
  ])
  if (!currentSkill) notFound()
  return <SkillsWorkspace currentSkill={currentSkill} skills={skills} />
}
