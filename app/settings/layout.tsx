import { SettingsShell } from '@/components/settings/settings-shell'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { listOrganizations } from '@/lib/organizations'
import { getAvatarUrl, getDefaultNickname, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent('/settings')}`)
  const [{ data: profile }, preferences, personalWorkspace, organizations] = await Promise.all([
    supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
    getUserPreferences(supabase, user.id),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!personalWorkspace) redirect('/app/onboarding')
  const nickname = (profile as { nickname?: string } | null)?.nickname || getDefaultNickname(user)
  return (
    <SettingsShell
      activeWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug, scopeType: personalWorkspace.scope_type, organizationId: personalWorkspace.organization_id }}
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      preferences={preferences}
    >{children}</SettingsShell>
  )
}
