import { ChatWorkspace } from '@/components/chat-workspace'
import { listConfiguredModels } from '@/lib/ai-provider-configurations.server'
import { listPersistedChatEvents } from '@/lib/chat-session-persistence.server'
import { listOrganizations } from '@/lib/organizations'
import { getChatSession, isChatSessionId, listChatSessions } from '@/lib/chat-sessions'
import { getAccessibleWorkspaceById, getAvatarUrl, getOwnedWorkspace } from '@/lib/workspaces'
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
    redirect(`/login?next=${encodeURIComponent(`/${userId}/cchat/${sessionId}`)}`)
  }

  if (userId !== user.id || !isChatSessionId(sessionId)) notFound()

  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) notFound()

  const [workspace, personalWorkspace, organizations, profile, configuredModels, chatSessions, initialEvents] = await Promise.all([
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
    listPersistedChatEvents(supabase, user.id, session.id),
  ])

  if (!workspace || !personalWorkspace) notFound()

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name

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
      autoStart={query.run === '1'}
      autoStartModel={session.provider_id && session.model_id ? { providerId: session.provider_id, modelId: session.model_id } : null}
      initialEvents={initialEvents}
      initialPrompt={session.initial_prompt}
      nickname={nickname}
      organizations={organizations}
      personalWorkspace={{ name: personalWorkspace.name, slug: personalWorkspace.slug }}
      sessionId={session.id}
      sessionTitle={session.title}
    />
  )
}
