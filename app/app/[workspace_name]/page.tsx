import { AppWorkspace } from '@/components/app-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { listOrganizations } from '@/lib/organizations'
import { ensureDraftProject, listProjects } from '@/lib/projects'
import { listChatSessions } from '@/lib/chat-sessions'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'OpenLink App',
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ prompt?: string; project?: string }>
}) {
  const [{ workspace_name }, { prompt = '', project: projectId }] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const next = `/app/${workspace_name}${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''}`
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspace_name),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) redirect('/app')

  const [projects, defaultProject, { data: profile }, configuredModels, chatSessions] = await Promise.all([
    listProjects(supabase, workspace.id),
    ensureDraftProject(supabase, user.id, workspace),
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
    listConfiguredModels(supabase, user.id),
    listChatSessions(supabase, user.id, workspace.id),
  ])

  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name

  return (
    <AppWorkspace
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      configuredModels={configuredModels}
      defaultProject={defaultProject}
      chatSessions={chatSessions}
      email={user.email ?? nickname}
      initialProjectId={projects.some((project) => project.id === projectId) ? projectId : undefined}
      initialPrompt={prompt}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      projects={projects}
      workspaceSlug={workspace.slug}
    />
  )
}
