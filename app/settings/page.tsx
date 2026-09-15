import { PreferencesForm } from '@/components/settings/preferences-form'
import { CloudConnectionsSettings } from '@/components/settings/cloud-connections'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function PreferencesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/settings')
  const preferences = await getUserPreferences(supabase, user.id)
  return <div className="size-full overflow-y-auto px-6 py-12 sm:px-10 lg:px-16"><PreferencesForm initial={preferences} />
    {getRuntimeMode() === 'cloud' && <CloudConnectionsSettings loginEnabled={process.env.OPENLINK_CLOUD_OAUTH_LOGIN_ENABLED === 'true'} locale={preferences.locale} />}
  </div>
}
