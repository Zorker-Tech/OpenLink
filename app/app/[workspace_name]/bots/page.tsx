import { BotWorkspace } from '@/components/bot/bot-workspace'
import { listOrganizations } from '@/lib/organizations'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'OpenLink Bots',
}

export default async function WorkspaceBotsPage({
  params,
}: {
  params: Promise<{ workspace_name: string }>
}) {
  const { workspace_name } = await params
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

  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname')
    .eq('user_id', user.id)
    .maybeSingle()
  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name

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
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      workspaceSlug={workspace.slug}
    />
  )
}
