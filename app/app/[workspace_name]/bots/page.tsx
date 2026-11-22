import { BotWorkspace } from '@/components/bot/bot-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { listBots } from '@/lib/bots'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { getWorkHostHealth, isWorkHostConfigured } from '@/lib/work-host-client.server'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'OpenLink Bots',
}

export default async function WorkspaceBotsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ bot?: string }>
}) {
  const [{ workspace_name }, { bot: requestedBotId }] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/app/${workspace_name}/bots`)}`)
  }

  const [workspace, personalWorkspace] = await Promise.all([
    getAccessibleWorkspace(supabase, workspace_name),
    getOwnedWorkspace(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) redirect('/app')

  const [{ data: profile }, models, bots, workHostHealth] = await Promise.all([
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
    listConfiguredModels(supabase, user.id),
    listBots(supabase, user.id, workspace.id),
    getWorkHostHealth(),
  ])
  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name
  const workHostReady = isWorkHostConfigured() && workHostHealth?.ok === true
  const selected = bots.find((bot) => bot.id === requestedBotId) ?? bots[0] ?? null
  const transcriptCacheKey = `openlink:bot-timelines:${user.id}:${workspace.id}`

  return (
    <BotWorkspace
      key={transcriptCacheKey}
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      initialBot={null}
      initialBotId={selected?.id}
      transcriptCacheKey={transcriptCacheKey}
      initialBots={bots}
      models={models}
      nickname={nickname}
      workspaceSlug={workspace.slug}
      workHostReady={workHostReady}
    />
  )
}
