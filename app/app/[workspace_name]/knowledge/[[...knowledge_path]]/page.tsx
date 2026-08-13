import { KnowledgeWorkspace } from '@/components/knowledge-workspace'
import { listOrganizations } from '@/lib/organizations'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Knowledge · OpenLink',
}

export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ workspace_name: string; knowledge_path?: string[] }>
}) {
  const { workspace_name: workspaceName, knowledge_path: knowledgePath = [] } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/app/${workspaceName}/knowledge${knowledgePath.length ? `/${knowledgePath.join('/')}` : ''}`)}`)
  }

  const [workspace, personalWorkspace, organizations, profile] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  if (!workspace || !personalWorkspace) redirect('/app')

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name

  return (
    <KnowledgeWorkspace
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      initialPath={knowledgePath}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      workspaceId={workspace.id}
    />
  )
}
