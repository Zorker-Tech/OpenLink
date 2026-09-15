import { ChatWorkspace } from '@/components/chat-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { listPersistedChatEvents } from '@/lib/chat-session-persistence.server'
import { listOrganizations } from '@/lib/organizations'
import { getProject } from '@/lib/projects'
import { getChatSession, isChatSessionId, listChatSessions } from '@/lib/chat-sessions'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { getUserSkill, listUserSkills } from '@/lib/user-skills.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { getAccessibleWorkspaceById, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { shouldAutoStartInitialPrompt } from '@/lib/chat-auto-start'
import { createClient } from '@/utils/supabase/server'
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'OpenLink Chat',
}

export default async function ChatSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ user_id: string; chat_sessions_id: string }>
  searchParams: Promise<{ run?: string }>
}) {
  const [{ user_id: userId, chat_sessions_id: sessionId }, query] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/${userId}/chat/${sessionId}`)}`)
  }

  if (userId !== user.id || !isChatSessionId(sessionId)) notFound()

  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) notFound()

  const [workspace, personalWorkspace, organizations, profile, configuredModels, chatSessions, project, initialEvents, skillSummaries, preferences] = await Promise.all([
    getAccessibleWorkspaceById(supabase, session.workspace_id),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
    supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle(),
    listConfiguredModels(supabase, user.id),
    listChatSessions(supabase, user.id, session.workspace_id),
    getProject(supabase, session.project_id),
    listPersistedChatEvents(supabase, user.id, session.id),
    listUserSkills(supabase, user.id),
    getUserPreferences(supabase, user.id),
  ])

  if (!workspace || !personalWorkspace || !project) notFound()

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  const skills = (await Promise.all(skillSummaries.map((skill) => getUserSkill(supabase, user.id, skill.id)))).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))

  return (
    <ChatWorkspace
      activeWorkspace={{
        name: workspace.name,
        slug: workspace.slug,
        scopeType: workspace.scope_type,
        organizationId: workspace.organization_id,
      }}
      avatarUrl={getAvatarUrl(user)}
      configuredModels={configuredModels}
      chatSessions={chatSessions}
      email={user.email ?? nickname}
      autoStart={shouldAutoStartInitialPrompt(query.run, session.initial_prompt, initialEvents)}
      autoStartModel={session.provider_id && session.model_id ? { providerId: session.provider_id, modelId: session.model_id } : null}
      initialEvents={initialEvents}
      initialPrompt={session.initial_prompt}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      projectId={project.id}
      projectName={project.name}
      sessionId={session.id}
      thinkingVisibility={preferences.thinkingVisibility}
      initialAccessMode={session.access_mode}
      composerResources={{
        agent: session.agent ?? 'codex',
        skills,
        customInstructions: preferences.customInstructions,
      }}
      sessionTitle={session.title}
      userId={user.id}
      localRuntime={isLocalRuntime()}
    />
  )
}
