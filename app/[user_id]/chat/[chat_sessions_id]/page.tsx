import { ChatWorkspace } from '@/components/chat-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { listPersistedChatEvents } from '@/lib/chat-session-persistence.server'
import { getChatSessionRun } from '@/lib/chat-session-runs.server'
import { listOrganizations } from '@/lib/organizations'
import { getProject } from '@/lib/projects'
import { getChatSession, isChatSessionId, listChatSessions } from '@/lib/chat-sessions'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { getUserSkill, listUserSkills } from '@/lib/user-skills.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { getAccessibleWorkspaceById, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
import { shouldAutoStartInitialPrompt } from '@/lib/chat-auto-start'
import { observeChatStage } from '@/lib/chat-diagnostics.server'
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

  const session = await observeChatStage('session.load', getChatSession(supabase, user.id, sessionId))
  if (!session) notFound()

  const [workspace, personalWorkspace, organizations, profile, configuredModels, chatSessions, project, initialEvents, skillSummaries, preferences, initialRun] = await Promise.all([
    observeChatStage('workspace.load', getAccessibleWorkspaceById(supabase, session.workspace_id)),
    observeChatStage('personal_workspace.load', getOwnedWorkspace(supabase, user.id)),
    observeChatStage('organizations.load', listOrganizations(supabase, user.id)),
    observeChatStage('profile.load', supabase
      .schema('openlink')
      .from('profiles')
      .select('nickname')
      .eq('user_id', user.id)
      .maybeSingle()),
    observeChatStage('models.load', listConfiguredModels(supabase, user.id)),
    observeChatStage('sessions.load', listChatSessions(supabase, user.id, session.workspace_id)),
    observeChatStage('project.load', getProject(supabase, session.project_id)),
    observeChatStage('events.load', listPersistedChatEvents(supabase, user.id, session.id)),
    observeChatStage('skills.load', listUserSkills(supabase, user.id)),
    observeChatStage('preferences.load', getUserPreferences(supabase, user.id)),
    observeChatStage('run.load', getChatSessionRun(supabase, user.id, session.id)),
  ])

  if (!workspace || !personalWorkspace || !project) notFound()

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  const skills = (await Promise.all(skillSummaries.map((skill) => observeChatStage(
    'skill.load',
    getUserSkill(supabase, user.id, skill.id),
  )))).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))

  return (
    <ChatWorkspace
      key={session.id}
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
      initialRun={initialRun}
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
