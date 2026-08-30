import { ProjectSupabasePanel } from '@/components/project-supabase-panel'
import { getChatSession, isChatSessionId, listChatSessions } from '@/lib/chat-sessions'
import { getProject } from '@/lib/projects'
import { listOrganizations } from '@/lib/organizations'
import { getAccessibleWorkspaceById, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Project Data — OpenLink' }

export default async function ProjectDataPage({
  params,
}: {
  params: Promise<{ user_id: string; chat_sessions_id: string }>
}) {
  const { user_id: userId, chat_sessions_id: sessionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/${userId}/chat/${sessionId}/data`)}`)
  if (user.id !== userId || !isChatSessionId(sessionId)) notFound()

  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) notFound()
  const [workspace, personalWorkspace, organizations, profile, chatSessions, project] = await Promise.all([
    getAccessibleWorkspaceById(supabase, session.workspace_id),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
    supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
    listChatSessions(supabase, user.id, session.workspace_id),
    getProject(supabase, session.project_id),
  ])
  if (!workspace || !personalWorkspace || !project) notFound()
  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name

  return <ProjectSupabasePanel
    activeWorkspace={{ name: workspace.name, slug: workspace.slug, scopeType: workspace.scope_type, organizationId: workspace.organization_id }}
    avatarUrl={getAvatarUrl(user)}
    chatSessions={chatSessions}
    email={user.email ?? nickname}
    nickname={nickname}
    organizations={organizations}
    personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
    projectId={project.id}
    projectName={project.name}
    sessionId={session.id}
    userId={user.id}
  />
}
