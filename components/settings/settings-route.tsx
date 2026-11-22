import { SettingsShell } from '@/components/settings/settings-shell'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'

export async function SettingsRoute({ children, intercepted = false }: { children: ReactNode; intercepted?: boolean }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings')
  const [workspace, preferences] = await Promise.all([
    getOwnedWorkspace(supabase, user.id),
    getUserPreferences(supabase, user.id),
  ])

  return (
    <SettingsShell closeHref={workspace ? `/app/${encodeURIComponent(workspace.slug)}` : '/app/onboarding'} intercepted={intercepted} initialTheme={preferences.theme}>
      {children}
    </SettingsShell>
  )
}
