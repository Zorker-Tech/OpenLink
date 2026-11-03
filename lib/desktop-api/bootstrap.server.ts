import 'server-only'

import { getAiProvider } from '@/lib/ai-providers'
import {
  getAiProviderConfiguration,
  listAiProviderConfigurations,
  listConfiguredModels,
} from '@/lib/ai-provider-configurations.server'
import { getAiProviderModels } from '@/lib/ai-provider-models.server'
import { shouldAutoStartInitialPrompt } from '@/lib/chat-auto-start'
import { observeChatStage } from '@/lib/chat-diagnostics.server'
import { getChatSession, isChatSessionId, listChatSessions } from '@/lib/chat-sessions'
import { listPersistedChatEvents } from '@/lib/chat-session-persistence.server'
import { getChatSessionRun } from '@/lib/chat-session-runs.server'
import { loadComposerContext } from '@/lib/composer-context'
import {
  getEmbeddingProviderConfiguration,
  listEmbeddingProviderConfigurations,
} from '@/lib/embedding-provider-configurations.server'
import { getEmbeddingProvider } from '@/lib/embedding-providers'
import { listOrganizations } from '@/lib/organizations'
import {
  getCloudConnection,
  listCloudConnections,
} from '@/lib/platform-cloud-connection.server'
import { cloudProjectLinksForRequest } from '@/lib/platform-cloud-project.server'
import type {
  CloudProjectConnectionState,
  CloudProjectOption,
} from '@/lib/platform-cloud-project'
import {
  ensureDraftProject,
  getDefaultProject,
  getProject,
  listProjects,
} from '@/lib/projects'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { getUserPreferences } from '@/lib/user-preferences.server'
import { getUserSkill, listUserSkills } from '@/lib/user-skills.server'
import {
  getAccessibleWorkspace,
  getAccessibleWorkspaceById,
  getAvatarUrl,
  getDefaultNickname,
  getOwnedWorkspace,
  resolveAppEntry,
} from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

export type DesktopBootstrapResult =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false
      status: number
      code: string
      message: string
      redirect?: string
    }

const unauthorized = (next: string): DesktopBootstrapResult => ({
  ok: false,
  status: 401,
  code: 'AUTH_REQUIRED',
  message: 'Authentication is required',
  redirect: `/login?next=${encodeURIComponent(next)}`,
})

const notFound = (message = 'Not found'): DesktopBootstrapResult => ({
  ok: false,
  status: 404,
  code: 'NOT_FOUND',
  message,
})

const redirectTo = (path: string): DesktopBootstrapResult => ({
  ok: false,
  status: 409,
  code: 'REDIRECT',
  message: path,
  redirect: path,
})

async function session(): Promise<{ supabase: SupabaseClient; user: Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user'] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { supabase, user }
}

function workspaceSummary(workspace: {
  name: string
  slug: string
  scope_type: 'personal' | 'organization'
  organization_id: string | null
}) {
  return {
    name: workspace.name,
    slug: workspace.slug,
    scopeType: workspace.scope_type,
    organizationId: workspace.organization_id,
  }
}

function personalSummary(workspace: { name: string; slug: string }) {
  return { name: workspace.name, slug: workspace.slug }
}

async function profileNickname(
  supabase: SupabaseClient,
  userId: string,
  fallback: string,
): Promise<string> {
  const { data } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname')
    .eq('user_id', userId)
    .maybeSingle()
  return (data as { nickname?: string } | null)?.nickname ?? fallback
}

/** Settings routes all render inside the same shell. */
async function settingsShell(supabase: SupabaseClient, user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>) {
  const [personalWorkspace, organizations, preferences] = await Promise.all([
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
    getUserPreferences(supabase, user.id),
  ])
  if (!personalWorkspace) return null
  const nickname = await profileNickname(supabase, user.id, getDefaultNickname(user))
  return {
    activeWorkspace: workspaceSummary(personalWorkspace),
    avatarUrl: getAvatarUrl(user),
    email: user.email ?? nickname,
    nickname,
    organizations,
    personalWorkspace: personalSummary(personalWorkspace),
    preferences,
  }
}

async function loadHome(search: URLSearchParams): Promise<DesktopBootstrapResult> {
  const { supabase, user } = await session()
  const composerContext = user ? await loadComposerContext(supabase, user.id) : null
  return {
    ok: true,
    data: {
      user: user
        ? {
            email: user.email ?? null,
            name:
              typeof user.user_metadata?.name === 'string'
                ? user.user_metadata.name
                : null,
          }
        : null,
      composerContext,
      runtimeMode: getRuntimeMode(),
      prompt: search.get('prompt') ?? '',
    },
  }
}

async function hasAccessibleCloudProject(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<boolean> {
  try {
    const project = await getDefaultProject(supabase, workspaceId)
    if (!project) return false
    const connections = await listCloudConnections()
    const connection = connections.find((item) =>
      ['active', 'refreshing'].includes(item.state),
    )
    if (!connection) return false
    const links = await cloudProjectLinksForRequest()
    await links.resolve(project.id, connection.id)
    return true
  } catch {
    return false
  }
}

async function loadAppEntry(search: URLSearchParams): Promise<DesktopBootstrapResult> {
  const { supabase, user } = await session()
  const prompt = search.get('prompt') ?? ''
  const withPrompt = (path: string) =>
    prompt ? `${path}?prompt=${encodeURIComponent(prompt)}` : path

  if (!user) return unauthorized(withPrompt('/app'))

  const entry = await resolveAppEntry(supabase, user)
  if (entry.needsOnboarding) return redirectTo(withPrompt('/app/onboarding'))
  if (entry.needsOrganizationOnboarding) {
    const step = getRuntimeMode() === 'cloud' ? 'project' : 'organization'
    return redirectTo(withPrompt(`/app/onboarding?step=${step}`))
  }
  if (
    getRuntimeMode() === 'cloud' &&
    !(await hasAccessibleCloudProject(supabase, entry.workspace.id))
  ) {
    return redirectTo(withPrompt('/app/onboarding?step=project'))
  }
  return redirectTo(withPrompt(`/app/${entry.workspace.slug}`))
}

async function loadWorkspace(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  workspaceName: string,
  search: URLSearchParams,
): Promise<DesktopBootstrapResult> {
  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) return redirectTo('/app')

  const [projects, defaultProject, profile, configuredModels, chatSessions, skillSummaries, preferences] =
    await Promise.all([
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
      listUserSkills(supabase, user.id),
      getUserPreferences(supabase, user.id),
    ])
  const skills = (
    await Promise.all(skillSummaries.map((skill) => getUserSkill(supabase, user.id, skill.id)))
  ).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))
  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name
  const projectId = search.get('project')

  return {
    ok: true,
    data: {
      activeWorkspace: workspaceSummary(workspace),
      avatarUrl: getAvatarUrl(user),
      configuredModels,
      defaultProject,
      chatSessions,
      email: user.email ?? nickname,
      initialProjectId: projects.some((project) => project.id === projectId)
        ? projectId ?? undefined
        : undefined,
      initialPrompt: search.get('prompt') ?? '',
      nickname,
      organizations,
      personalWorkspace: personalSummary(personalWorkspace),
      projects,
      runtimeMode: getRuntimeMode(),
      workspaceSlug: workspace.slug,
      composerSkills: skills,
      customInstructions: preferences.customInstructions,
    },
  }
}

async function loadProjects(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  workspaceName: string,
): Promise<DesktopBootstrapResult> {
  const [workspace, personalWorkspace, organizations] = await Promise.all([
    getAccessibleWorkspace(supabase, workspaceName),
    getOwnedWorkspace(supabase, user.id),
    listOrganizations(supabase, user.id),
  ])
  if (!workspace || !personalWorkspace) return redirectTo('/app')

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
  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name
  const organizationRole = workspace.organization_id
    ? organizations.find((organization) => organization.id === workspace.organization_id)?.role
    : null
  const canManageProjects =
    workspace.scope_type === 'personal' ||
    organizationRole === 'owner' ||
    organizationRole === 'admin'

  return {
    ok: true,
    data: {
      activeWorkspace: workspaceSummary(workspace),
      avatarUrl: getAvatarUrl(user),
      canManageProjects,
      chatSessions,
      email: user.email ?? nickname,
      nickname,
      organizations,
      personalWorkspace: personalSummary(personalWorkspace),
      projects,
    },
  }
}

async function loadKnowledge(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  workspaceName: string,
  search: URLSearchParams,
): Promise<DesktopBootstrapResult> {
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
  if (!workspace || !personalWorkspace) return redirectTo('/app')

  const chatSessions = await listChatSessions(supabase, user.id, workspace.id)
  const nickname = (profile as { nickname?: string } | null)?.nickname ?? workspace.name
  const path = (search.get('path') ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)

  return {
    ok: true,
    data: {
      activeWorkspace: workspaceSummary(workspace),
      avatarUrl: getAvatarUrl(user),
      chatSessions,
      email: user.email ?? nickname,
      initialPath: path,
      knowledgeEnabled:
        process.env.OPENLINK_KNOWLEDGE_ENABLED !== '0' &&
        process.env.OPENLINK_DEPLOYMENT_PROFILE !== 'core',
      nickname,
      organizations,
      personalWorkspace: personalSummary(personalWorkspace),
      workspaceId: workspace.id,
    },
  }
}

async function loadChat(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  userId: string,
  sessionId: string,
  search: URLSearchParams,
): Promise<DesktopBootstrapResult> {
  const next = `/${userId}/chat/${sessionId}`
  if (user.id !== userId || !isChatSessionId(sessionId)) return notFound('Chat session was not found')

  const chat = await observeChatStage('session.load', getChatSession(supabase, user.id, sessionId))
  if (!chat) return notFound('Chat session was not found')

  const [
    workspace,
    personalWorkspace,
    organizations,
    profile,
    configuredModels,
    chatSessions,
    project,
    initialEvents,
    skillSummaries,
    preferences,
    initialRun,
  ] = await Promise.all([
    observeChatStage('workspace.load', getAccessibleWorkspaceById(supabase, chat.workspace_id)),
    observeChatStage('personal_workspace.load', getOwnedWorkspace(supabase, user.id)),
    observeChatStage('organizations.load', listOrganizations(supabase, user.id)),
    observeChatStage(
      'profile.load',
      supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
    ),
    observeChatStage('models.load', listConfiguredModels(supabase, user.id)),
    observeChatStage('sessions.load', listChatSessions(supabase, user.id, chat.workspace_id)),
    observeChatStage('project.load', getProject(supabase, chat.project_id)),
    observeChatStage('events.load', listPersistedChatEvents(supabase, user.id, chat.id)),
    observeChatStage('skills.load', listUserSkills(supabase, user.id)),
    observeChatStage('preferences.load', getUserPreferences(supabase, user.id)),
    observeChatStage('run.load', getChatSessionRun(supabase, user.id, chat.id)),
  ])
  if (!workspace || !personalWorkspace || !project) return notFound('Chat session was not found')

  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  const skills = (
    await Promise.all(
      skillSummaries.map((skill) =>
        observeChatStage('skill.load', getUserSkill(supabase, user.id, skill.id)),
      ),
    )
  ).filter((skill): skill is NonNullable<typeof skill> => Boolean(skill))

  return {
    ok: true,
    data: {
      activeWorkspace: workspaceSummary(workspace),
      avatarUrl: getAvatarUrl(user),
      configuredModels,
      chatSessions,
      email: user.email ?? nickname,
      autoStart: shouldAutoStartInitialPrompt(
        search.get('run'),
        chat.initial_prompt,
        initialEvents,
      ),
      autoStartModel:
        chat.provider_id && chat.model_id
          ? { providerId: chat.provider_id, modelId: chat.model_id }
          : null,
      initialEvents,
      initialRun,
      initialPrompt: chat.initial_prompt,
      nickname,
      organizations,
      personalWorkspace: personalSummary(personalWorkspace),
      projectId: project.id,
      projectName: project.name,
      sessionId: chat.id,
      thinkingVisibility: preferences.thinkingVisibility,
      initialAccessMode: chat.access_mode,
      composerResources: {
        agent: chat.agent ?? 'codex',
        skills,
        customInstructions: preferences.customInstructions,
      },
      sessionTitle: chat.title,
      userId: user.id,
      localRuntime: getRuntimeMode() === 'local',
      next: search.get('run') ? next : undefined,
    },
  }
}

async function loadChatData(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  userId: string,
  sessionId: string,
): Promise<DesktopBootstrapResult> {
  if (user.id !== userId || !isChatSessionId(sessionId)) return notFound('Chat session was not found')
  const chat = await getChatSession(supabase, user.id, sessionId)
  if (!chat) return notFound('Chat session was not found')
  const [workspace, personalWorkspace, organizations, profile, chatSessions, project] =
    await Promise.all([
      getAccessibleWorkspaceById(supabase, chat.workspace_id),
      getOwnedWorkspace(supabase, user.id),
      listOrganizations(supabase, user.id),
      supabase.schema('openlink').from('profiles').select('nickname').eq('user_id', user.id).maybeSingle(),
      listChatSessions(supabase, user.id, chat.workspace_id),
      getProject(supabase, chat.project_id),
    ])
  if (!workspace || !personalWorkspace || !project) return notFound('Chat session was not found')
  const nickname = (profile.data as { nickname?: string } | null)?.nickname ?? workspace.name
  return {
    ok: true,
    data: {
      activeWorkspace: workspaceSummary(workspace),
      avatarUrl: getAvatarUrl(user),
      chatSessions,
      email: user.email ?? nickname,
      nickname,
      organizations,
      personalWorkspace: personalSummary(personalWorkspace),
      projectId: project.id,
      projectName: project.name,
      sessionId: chat.id,
      userId: user.id,
    },
  }
}

async function loadSettings(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  path: string[],
): Promise<DesktopBootstrapResult> {
  const shell = await settingsShell(supabase, user)
  if (!shell) return redirectTo('/app/onboarding')

  if (path.length === 0) {
    return {
      ok: true,
      data: {
        shell,
        page: { preferences: shell.preferences },
      },
    }
  }

  const [section, id] = path
  if (section === 'providers') {
    if (!id) {
      const [configurations, embeddingConfigurations] = await Promise.all([
        listAiProviderConfigurations(supabase, user.id),
        listEmbeddingProviderConfigurations(supabase, user.id),
      ])
      return { ok: true, data: { shell, page: { configurations, embeddingConfigurations } } }
    }
    const provider = getAiProvider(id)
    if (!provider) return notFound('AI provider was not found')
    const [configuration, configurations, embeddingConfigurations, models] = await Promise.all([
      getAiProviderConfiguration(supabase, user.id, id),
      listAiProviderConfigurations(supabase, user.id),
      listEmbeddingProviderConfigurations(supabase, user.id),
      getAiProviderModels(id),
    ])
    return {
      ok: true,
      data: {
        shell,
        page: { configuration, configurations, currentProviderId: id, embeddingConfigurations, models, provider },
      },
    }
  }

  if (section === 'embeddings') {
    if (!id) {
      const [configurations, embeddingConfigurations] = await Promise.all([
        listAiProviderConfigurations(supabase, user.id),
        listEmbeddingProviderConfigurations(supabase, user.id),
      ])
      return { ok: true, data: { shell, page: { configurations, embeddingConfigurations } } }
    }
    const provider = getEmbeddingProvider(id)
    if (!provider) return notFound('Embedding provider was not found')
    const [configuration, configurations, embeddingConfigurations] = await Promise.all([
      getEmbeddingProviderConfiguration(supabase, user.id, id),
      listAiProviderConfigurations(supabase, user.id),
      listEmbeddingProviderConfigurations(supabase, user.id),
    ])
    return {
      ok: true,
      data: {
        shell,
        page: { configuration, configurations, currentProviderId: id, embeddingConfigurations, provider },
      },
    }
  }

  if (section === 'skills') {
    const skills = await listUserSkills(supabase, user.id)
    if (!id) return { ok: true, data: { shell, page: { skills } } }
    const currentSkill = await getUserSkill(supabase, user.id, id)
    if (!currentSkill) return notFound('Skill was not found')
    return { ok: true, data: { shell, page: { skills, currentSkill } } }
  }

  return notFound('Settings page was not found')
}

async function loadCloudProjectSetup(): Promise<{
  connectionId: string | null
  connectionState: CloudProjectConnectionState
  projects: CloudProjectOption[]
}> {
  try {
    const connections = await listCloudConnections()
    const connection = connections.find((item) =>
      ['active', 'refreshing', 'reauth_required'].includes(item.state),
    )
    if (!connection) return { connectionId: null, connectionState: 'disconnected', projects: [] }
    if (connection.state === 'reauth_required') {
      return { connectionId: connection.id, connectionState: 'reauth_required', projects: [] }
    }
    const current = await getCloudConnection(connection.id)
    if (!['active', 'refreshing'].includes(current.state)) {
      return { connectionId: connection.id, connectionState: 'reauth_required', projects: [] }
    }
    const projects = await current.sdk.listProjects()
    return {
      connectionId: connection.id,
      connectionState: 'active',
      projects: projects.map(({ id, name, organizationId }) => ({ id, name, organizationId })),
    }
  } catch {
    return { connectionId: null, connectionState: 'load_error', projects: [] }
  }
}

async function loadOnboarding(
  supabase: SupabaseClient,
  user: NonNullable<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>['data']['user']>,
  search: URLSearchParams,
): Promise<DesktopBootstrapResult> {
  const prompt = search.get('prompt') ?? ''
  const requestedStep = search.get('step')
  const isCloud = getRuntimeMode() === 'cloud'
  const { data: profile } = await supabase
    .schema('openlink')
    .from('profiles')
    .select('nickname, nickname_confirmed, organization_onboarding_completed')
    .eq('user_id', user.id)
    .maybeSingle()
  const typedProfile = profile as {
    nickname?: string
    nickname_confirmed?: boolean
    organization_onboarding_completed?: boolean
  } | null
  const isCloudProjectStep = isCloud && Boolean(typedProfile?.nickname_confirmed)
  const isOrganizationStep =
    !isCloud && (requestedStep === 'organization' || Boolean(typedProfile?.nickname_confirmed))
  const isSecondStep = isCloud ? isCloudProjectStep : isOrganizationStep
  if (isSecondStep && !isCloudProjectStep && typedProfile?.organization_onboarding_completed) {
    return redirectTo('/app')
  }
  return {
    ok: true,
    data: {
      profile: typedProfile ?? null,
      prompt,
      isCloud,
      isCloudProjectStep,
      isOrganizationStep,
      defaultNickname: typedProfile?.nickname ?? getDefaultNickname(user),
      cloudProjectSetup: isCloudProjectStep ? await loadCloudProjectSetup() : undefined,
    },
  }
}

export async function loadDesktopBootstrap(
  path: string[],
  search: URLSearchParams,
): Promise<DesktopBootstrapResult> {
  const { supabase, user } = await session()
  const [head, second, third, fourth] = path

  if (head === 'home') return loadHome(search)
  if (head === 'app-entry') return loadAppEntry(search)

  if (!user) {
    const next = path.join('/')
    return unauthorized(`/desktop/${next}`)
  }

  if (head === 'workspace' && second) {
    if (third === 'projects') return loadProjects(supabase, user, second)
    if (third === 'knowledge') return loadKnowledge(supabase, user, second, search)
    if (!third) return loadWorkspace(supabase, user, second, search)
  }

  // Chat routes carry their user id in the path so the loader can reject a
  // session that belongs to another account before touching the database.
  if (head === 'chat' && second && third) {
    if (fourth === 'data') return loadChatData(supabase, user, second, third)
    return loadChat(supabase, user, second, third, search)
  }

  if (head === 'settings') return loadSettings(supabase, user, path.slice(1))
  if (head === 'onboarding') return loadOnboarding(supabase, user, search)

  return notFound('Desktop bootstrap route was not found')
}
