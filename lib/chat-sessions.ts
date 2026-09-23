import 'server-only'

import { randomBytes } from 'node:crypto'
import { resolveConfiguredModelSelection } from '@/lib/ai-provider-configurations.server'
import { getT } from '@/lib/i18n/server'
import type { Translator } from '@/lib/i18n/messages'
import { ensureDraftProject, getProject } from '@/lib/projects'
import type { AgentKind, ChatSessionSummary } from '@/lib/chat-session-types'
import { getAccessibleWorkspace, getOwnedWorkspace, type OpenLinkWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export const CHAT_SESSION_ID_LENGTH = 11
export const CHAT_SESSION_ID_PATTERN = /^[A-Za-z0-9]{11}$/

const CHAT_SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const CHAT_SESSION_ALPHABET_SIZE = CHAT_SESSION_ALPHABET.length
const RANDOM_BYTE_LIMIT = 256 - (256 % CHAT_SESSION_ALPHABET_SIZE)

export type AccessMode = 'restricted' | 'ask' | 'open'
export const ACCESS_MODES: readonly AccessMode[] = ['restricted', 'ask', 'open']
export const DEFAULT_ACCESS_MODE: AccessMode = 'restricted'

export const AGENT_KINDS: readonly AgentKind[] = ['codex', 'pi']
export const DEFAULT_AGENT_KIND: AgentKind = 'codex'

export interface ChatSession {
  id: string
  user_id: string
  workspace_id: string
  project_id: string
  provider_id: string | null
  model_id: string | null
  agent: AgentKind
  title: string
  initial_prompt: string
  access_mode: AccessMode
  created_at: string
  updated_at: string
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

export function isChatSessionId(value: string) {
  return CHAT_SESSION_ID_PATTERN.test(value)
}

export function generateChatSessionId() {
  let result = ''

  while (result.length < CHAT_SESSION_ID_LENGTH) {
    const bytes = randomBytes(CHAT_SESSION_ID_LENGTH)
    for (const byte of bytes) {
      if (byte >= RANDOM_BYTE_LIMIT) continue
      result += CHAT_SESSION_ALPHABET[byte % CHAT_SESSION_ALPHABET_SIZE]
      if (result.length === CHAT_SESSION_ID_LENGTH) break
    }
  }

  return result
}

/**
 * Keeps the authored source title for callers that have no request locale
 * (the title route derives a provisional title outside a translated render).
 */
const sourceTranslator: Translator = (source) => source

export function deriveChatSessionTitle(prompt: string, t: Translator = sourceTranslator) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (!normalized) return t('新聊天')
  const characters = Array.from(normalized)
  return characters.length > 48 ? `${characters.slice(0, 48).join('')}…` : normalized
}

export async function listChatSessions(
  supabase: ServerSupabaseClient,
  userId: string,
  workspaceId: string,
  limit = 30,
): Promise<ChatSessionSummary[]> {
  const { t } = await getT()
  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .select('id, user_id, project_id, title, initial_prompt, agent, updated_at')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100))

  if (error) throw error
  const sessions = (data ?? []) as Array<{
    id: string
    user_id: string
    project_id: string
    title: string
    initial_prompt: string
    agent?: AgentKind
    updated_at: string
  }>
  const projectIds = [...new Set(sessions.map((session) => session.project_id).filter(Boolean))]
  const projectById = new Map<string, { name: string; is_default: boolean }>()

  if (projectIds.length) {
    const { data: projects, error: projectsError } = await supabase
      .schema('openlink')
      .from('projects')
      .select('id, name, is_default')
      .in('id', projectIds)

    if (projectsError) throw projectsError
    for (const project of (projects ?? []) as Array<{ id: string; name: string; is_default: boolean }>) {
      projectById.set(project.id, { name: project.name, is_default: project.is_default })
    }
  }

  return sessions.map((session) => {
    const project = projectById.get(session.project_id)
    return {
      id: session.id,
      userId: session.user_id,
      title: session.title === t('AI Elements 集成') && session.initial_prompt
        ? deriveChatSessionTitle(session.initial_prompt, t)
        : session.title,
      updatedAt: session.updated_at,
      projectId: session.project_id || 'draft',
      projectName: project?.name ?? 'Draft',
      projectIsDefault: project?.is_default ?? true,
      agent: session.agent ?? 'codex',
    }
  })
}

export async function getChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
) {
  if (!isChatSessionId(sessionId)) return null

  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .select('id, user_id, workspace_id, project_id, provider_id, model_id, agent, title, initial_prompt, access_mode, created_at, updated_at')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data as ChatSession | null
}

export async function updateChatSessionTitle(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
  title: string,
) {
  if (!isChatSessionId(sessionId)) throw new Error('CHAT_SESSION_NOT_FOUND')
  const nextTitle = title.trim().slice(0, 120)
  if (!nextTitle) throw new Error('CHAT_SESSION_TITLE_REQUIRED')

  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .update({ title: nextTitle, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select('title')
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('CHAT_SESSION_NOT_FOUND')
  return (data as { title: string }).title
}

export async function deleteChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  if (!isChatSessionId(sessionId)) throw new Error('CHAT_SESSION_NOT_FOUND')

  // Child records (events, pi entries, leases, event counters) reference this
  // row with ON DELETE CASCADE, so a single owner-scoped delete is sufficient.
  const { error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', userId)

  if (error) throw error
}

export async function updateChatSessionAccessMode(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
  mode: AccessMode,
): Promise<AccessMode> {
  if (!isChatSessionId(sessionId)) throw new Error('CHAT_SESSION_NOT_FOUND')
  if (!ACCESS_MODES.includes(mode)) throw new Error('CHAT_SESSION_ACCESS_MODE_INVALID')

  const { data, error } = await supabase
    .schema('openlink')
    .from('chat_sessions')
    .update({ access_mode: mode, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .select('access_mode')
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('CHAT_SESSION_NOT_FOUND')
  return (data as { access_mode: AccessMode }).access_mode
}

export async function createChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  options: {
    prompt?: string
    workspaceSlug?: string
    projectId?: string | null
    providerId?: string
    modelId?: string
    accessMode?: AccessMode
    agent?: AgentKind
  },
) {
  const { t } = await getT()
  const workspace = options.workspaceSlug
    ? await getAccessibleWorkspace(supabase, options.workspaceSlug)
    : await getOwnedWorkspace(supabase, userId)

  if (!workspace) throw new Error('CHAT_WORKSPACE_NOT_FOUND')

  let project = null
  const requestedProjectId = options.projectId?.trim() || null
  if (!requestedProjectId) {
    project = await ensureDraftProject(supabase, userId, workspace)
  } else {
    project = await getProject(supabase, requestedProjectId)
  }
  if (!project || project.workspace_id !== workspace.id) {
    throw new Error('CHAT_PROJECT_NOT_FOUND')
  }
  if (project.status !== 'active' || project.runtime_status !== 'ready') {
    throw new Error('PROJECT_RUNTIME_NOT_READY')
  }
  const projectId = project.id

  const initialPrompt = options.prompt?.trim().slice(0, 10000) ?? ''
  const title = deriveChatSessionTitle(initialPrompt, t)
  const requestedModel = options.providerId && options.modelId
    ? { providerId: options.providerId, modelId: options.modelId }
    : null
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new Error('MODEL_CONFIGURATION_REQUIRED')

  const effectiveAgent = options.agent && AGENT_KINDS.includes(options.agent)
    ? options.agent
    : project.default_agent && AGENT_KINDS.includes(project.default_agent as AgentKind)
      ? (project.default_agent as AgentKind)
      : DEFAULT_AGENT_KIND

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateChatSessionId()
    const { data, error } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .insert({
        id,
        user_id: userId,
        workspace_id: workspace.id,
        project_id: projectId,
        provider_id: selectedModel.providerId,
        model_id: selectedModel.modelId,
        agent: effectiveAgent,
        title,
        initial_prompt: initialPrompt,
        access_mode: options.accessMode ?? DEFAULT_ACCESS_MODE,
      })
      .select('id, user_id, workspace_id, project_id, provider_id, model_id, agent, title, initial_prompt, access_mode, created_at, updated_at')
      .single()

    if (!error) return { session: data as ChatSession, workspace: workspace as OpenLinkWorkspace }
    if (error.code !== '23505') throw error
  }

  throw new Error('CHAT_SESSION_ID_CONFLICT')
}

export async function forkChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  source: ChatSession,
): Promise<ChatSession> {
  if (source.user_id !== userId) throw new Error('CHAT_SESSION_NOT_FOUND')
  const { t } = await getT()
  const title = deriveChatSessionTitle(t('{title} 分支', { title: source.title }), t)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = generateChatSessionId()
    const { data, error } = await supabase
      .schema('openlink')
      .from('chat_sessions')
      .insert({
        id,
        user_id: userId,
        workspace_id: source.workspace_id,
        project_id: source.project_id,
        provider_id: source.provider_id,
        model_id: source.model_id,
        agent: source.agent,
        title,
        initial_prompt: '',
        access_mode: source.access_mode,
      })
      .select('id, user_id, workspace_id, project_id, provider_id, model_id, agent, title, initial_prompt, access_mode, created_at, updated_at')
      .single()
    if (!error) return data as ChatSession
    if (error.code !== '23505') throw error
  }
  throw new Error('CHAT_SESSION_ID_CONFLICT')
}
