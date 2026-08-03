import { OpenLinkHome } from '@/components/openlink-home'
import { createClient } from '@/utils/supabase/server'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <OpenLinkHome
      user={user ? {
        email: user.email ?? null,
        name: typeof user.user_metadata?.name === 'string' ? user.user_metadata.name : null,
      } : null}
    />
  )
}
