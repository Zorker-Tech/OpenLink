import { listChatSessions } from '@/lib/chat-sessions'
import { ProjectsWorkspace } from '@/components/projects-workspace'
import { getT } from '@/lib/i18n/server'
import { listOrganizations, type OrganizationSummary } from '@/lib/organizations'
import { listProjects } from '@/lib/projects'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('Projects · OpenLink') }
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ openPreview?: string | string[] }>
}) {
  const [{ workspace_name: workspaceName }, search] = await Promise.all([params, searchParams])
  const openPreview = typeof search.openPreview === 'string' ? search.openPreview : undefined
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const requestedPath = `/app/${workspaceName}/projects${openPreview ? `?openPreview=${encodeURIComponent(openPreview)}` : ''}`
    redirect(`/login?next=${encodeURIComponent(requestedPath)}`)
  }

  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) redirect('/app')

  const [projects, profile, chatSessions] = await Promise.all([
    listProjects(supabase, workspace.id),
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
    listChatSessions(supabase, user.id, workspace.id),
  ])

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  const previewProject = openPreview && openPreview !== 'first-ready'
    ? projects.find((project) => project.id === openPreview)
    : projects.find((project) => project.kind === 'code' && project.status === 'active' && project.runtime_status === 'ready')
  const initialPreviewProjectId = previewProject?.kind === 'code'
    && previewProject.status === 'active'
    && previewProject.runtime_status === 'ready'
    ? previewProject.id
    : null
  const organizationRole = workspace.organization_id
    ? organizations.find((organization: OrganizationSummary) => organization.id === workspace.organization_id)?.role
    : null
  const canManageProjects = workspace.scope_type === 'personal'
    || organizationRole === 'owner'
    || organizationRole === 'admin'

  return (
    <ProjectsWorkspace
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      canManageProjects={canManageProjects}
      chatSessions={chatSessions}
      initialPreviewProjectId={initialPreviewProjectId}
      email={user.email ?? nickname}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      projects={projects}
    />
  )
}
