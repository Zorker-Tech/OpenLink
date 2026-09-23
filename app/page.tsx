import { OpenLinkHome } from '@/components/openlink-home'
import { loadComposerContext } from '@/lib/composer-context'
import { createClient } from '@/utils/supabase/server'

export default async function Home() {
  if (process.env.OPENLINK_STATIC_UI === '1') {
    return <OpenLinkHome user={null} composerContext={null} />
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Behind the login gate the marketing composer renders a fully functional
  // prompt input (model + workspace + project pickers and voice), so load the
  // composer context for a signed-in user; anonymous visitors get no context
  // and are redirected to login/register on submit.
  const composerContext = user ? await loadComposerContext(supabase, user.id) : null

  return (
    <OpenLinkHome
      user={user ? {
        email: user.email ?? null,
        name: typeof user.user_metadata?.name === 'string' ? user.user_metadata.name : null,
      } : null}
      composerContext={composerContext}
    />
  )
}
