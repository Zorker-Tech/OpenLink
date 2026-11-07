import { ProjectPreviewWorkspace } from '@/components/project-preview-workspace'
import { getT } from '@/lib/i18n/server'
import { listOrganizations } from '@/lib/organizations'
import { listProjects } from '@/lib/projects'
import { isPreviewTargetId } from '@/lib/browser-preview-target-id'
import { getAccessibleWorkspace, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT()
  return { title: t('预览 · OpenLink') }
}

export default async function WorkspacePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace_name: string }>
  searchParams: Promise<{ project?: string; target?: string }>
}) {
  const [{ workspace_name: workspaceName }, query] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/app/${workspaceName}/preview`)}`)

  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) redirect('/app')

  const [allProjects, { data: profile }] = await Promise.all([
    listProjects(supabase, workspace.id),
    supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
  ])
  const projects = allProjects.filter((project) => project.kind === 'code').map((project) => ({
    id: project.id,
    name: project.name,
    source_url: project.source_url,
    description: project.description,
  }))
  const selectedProjectId = projects.some((project) => project.id === query.project)
    ? query.project
    : projects[0]?.id
  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name

  return (
    <ProjectPreviewWorkspace
      activeWorkspace={{ name: workspace.name, slug: workspace.slug, scopeType: workspace.scope_type, organizationId: workspace.organization_id }}
      avatarUrl={getAvatarUrl(user)}
      email={user.email ?? nickname}
      initialPreviewTargetId={isPreviewTargetId(query.target) ? query.target : undefined}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      projects={projects}
      selectedProjectId={selectedProjectId}
    />
  )
}
