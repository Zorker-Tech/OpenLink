import { PreferencesForm } from '@/components/settings/preferences-form'
import { CloudConnectionsSettings } from '@/components/settings/cloud-connections'
import { SettingsAccount } from '@/components/settings/settings-account'
import { getT } from '@/lib/i18n/server'
import { listOrganizations } from '@/lib/organizations'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { getAvatarUrl, getDefaultNickname } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function PreferencesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings')
  const [preferences, { data: profile }, { t }, organizations] = await Promise.all([
    getUserPreferences(supabase, user.id),
    supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
    getT(),
    listOrganizations(supabase, user.id),
  ])
  const nickname = (profile as { nickname?: string } | null)?.nickname || getDefaultNickname(user)
  const cloudRuntime = getRuntimeMode() === 'cloud'

  return (
    <div className="settings-general">
      <h1>{t('通用')}</h1>
      <SettingsAccount avatarUrl={getAvatarUrl(user)} cloudRuntime={cloudRuntime} email={user.email ?? nickname} nickname={nickname} organizations={organizations} />
      <PreferencesForm initial={preferences} />
      {cloudRuntime && <CloudConnectionsSettings loginEnabled={process.env.NODE_ENV !== 'production' && process.env.OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED === 'true'} locale={preferences.locale} />}
    </div>
  )
}
