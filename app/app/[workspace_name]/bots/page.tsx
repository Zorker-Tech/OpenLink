import { BotWorkspace } from '@/components/bot/bot-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { getBotDetail, listBots } from '@/lib/bots'
import type { BotDetail } from '@/lib/bot-types'
import { listOrganizations } from '@/lib/organizations'
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

  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspace_name),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
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
  const selected = bots.find((bot) => bot.id === requestedBotId) ?? bots[0] ?? null
  let initialBot: BotDetail | null = null
  if (selected) {
    try {
      initialBot = await getBotDetail(supabase, user.id, selected)
    } catch (error) {
      console.error('[openlink-bots] initial detail failed', error)
    }
  }

  return (
    <BotWorkspace
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      initialBot={initialBot}
      initialBots={bots}
      models={models}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      workspaceSlug={workspace.slug}
      workHostReady={isWorkHostConfigured() && workHostHealth?.ok === true}
    />
  )
}
