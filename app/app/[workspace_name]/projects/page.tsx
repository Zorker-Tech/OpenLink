import { ProjectsWorkspace } from '@/components/projects-workspace'
import { getT } from '@/lib/i18n/server'
import { listOrganizations } from '@/lib/organizations'
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
}: {
  params: Promise<{ workspace_name: string }>
}) {
  const { workspace_name: workspaceName } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/app/${workspaceName}/projects`)}`)
  }

  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) redirect('/app')

  const [projects, profile] = await Promise.all([
    listProjects(supabase, workspace.id),
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  const organizationRole = workspace.organization_id
    ? organizations.find((organization) => organization.id === workspace.organization_id)?.role
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
      email={user.email ?? nickname}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      projects={projects}
    />
  )
}
