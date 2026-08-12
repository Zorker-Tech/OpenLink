import { SkillsWorkspace } from '@/components/settings/skills-workspace'
import { listUserSkills } from '@/lib/user-skills.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function SkillsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings/skills')
  const skills = await listUserSkills(supabase, user.id)
  return <SkillsWorkspace skills={skills} />
}
