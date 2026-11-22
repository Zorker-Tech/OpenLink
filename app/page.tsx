import { OpenLinkDemo } from '@zorker/bot-demo/embed'
import '@zorker/bot-demo/embed.css'
import { OpenLinkHome } from '@/components/openlink-home'
import { loadComposerContext } from '@/lib/composer-context'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { createClient } from '@/utils/supabase/server'

function BotDemoSection() {
  return (
    <section aria-labelledby="home-bot-demo-title" className="mt-16 w-full max-w-[1120px] sm:mt-24">
      <h2 className="mb-5 text-2xl font-semibold tracking-tight text-[var(--app-foreground)] sm:text-3xl" id="home-bot-demo-title">Try OpenLink Bot</h2>
      <OpenLinkDemo />
    </section>
  )
}

export default async function Home() {
  if (process.env.OPENLINK_STATIC_UI === '1') {
    return <OpenLinkHome botDemo={<BotDemoSection />} user={null} composerContext={null} runtimeMode={getRuntimeMode()} />
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
      botDemo={<BotDemoSection />}
      user={user ? {
        email: user.email ?? null,
        name: typeof user.user_metadata?.name === 'string' ? user.user_metadata.name : null,
      } : null}
      composerContext={composerContext}
      runtimeMode={getRuntimeMode()}
    />
  )
}
