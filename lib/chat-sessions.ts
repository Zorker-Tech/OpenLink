import 'server-only'

import { randomBytes } from 'node:crypto'
import { resolveConfiguredModelSelection } from '@/lib/ai-provider-configurations.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
import { effectiveChatSessionRunStatus, listLatestChatSessionRuns } from '@/lib/chat-session-runs.server'
import { getT } from '@/lib/i18n/server'
import type { Translator } from '@/lib/i18n/messages'
import { ensureDraftProject, getProject } from '@/lib/projects'
import { isChatSessionSurface, type ChatSessionSurface } from '@/lib/chat-session-surface'
import type { AgentKind, ChatSessionSummary } from '@/lib/chat-session-types'
import { getAccessibleWorkspace, getOwnedWorkspace, type OpenLinkWorkspace } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export type { ChatSessionSurface } from '@/lib/chat-session-surface'

export const CHAT_SESSION_ID_LENGTH = 11
export const CHAT_SESSION_ID_PATTERN = /^[A-Za-z0-9]{11}$/

const CHAT_SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const CHAT_SESSION_ALPHABET_SIZE = CHAT_SESSION_ALPHABET.length
const RANDOM_BYTE_LIMIT = 256 - (256 % CHAT_SESSION_ALPHABET_SIZE)

export type AccessMode = 'restricted' | 'ask' | 'open'
export const DEFAULT_ACCESS_MODE: AccessMode = 'restricted'

export const AGENT_KINDS: readonly AgentKind[] = ['codex', 'pi', 'omp']
const LOCAL_AGENT_KINDS: readonly AgentKind[] = ['codex', 'pi']
const CLOUD_AGENT_KINDS: readonly AgentKind[] = ['pi', 'omp']
export const DEFAULT_AGENT_KIND: AgentKind = 'codex'

function normalizedAgent(value: unknown, allowed: readonly AgentKind[], fallback: AgentKind): AgentKind {
  return typeof value === 'string' && allowed.includes(value as AgentKind) ? value as AgentKind : fallback
}

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
  surface: ChatSessionSurface
  created_at: string
  updated_at: string
}

export interface CodeChatSession extends ChatSession {
  surface: 'code'
}

export interface BotChatSession extends ChatSession {
  surface: 'bot'
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>

const CHAT_SESSION_SELECT = 'id, user_id, workspace_id, project_id, provider_id, model_id, agent, title, initial_prompt, access_mode, created_at, updated_at, surface'

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
    .select('id, user_id, project_id, title, initial_prompt, agent, labels, updated_at')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('surface', 'code')
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
    labels?: string[] | null
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

  const runs = await listLatestChatSessionRuns(supabase, userId, sessions.map((session) => session.id))
  const cloudMode = getRuntimeMode() === 'cloud'
  return sessions.map((session) => {
    const run = runs.get(session.id) ?? null
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
      agent: cloudMode
        ? normalizedAgent(session.agent, CLOUD_AGENT_KINDS, 'pi')
        : normalizedAgent(session.agent, LOCAL_AGENT_KINDS, 'codex'),
      labels: session.labels ?? [],
      runStatus: effectiveChatSessionRunStatus(run),
      ...(run?.processId ? { runProcessId: run.processId } : {}),
      ...(run?.startedAt ? { runStartedAt: run.startedAt } : {}),
    }
  })
}

/**
 * Apply the execution-mode normalization once for every surface. Cloud
 * sessions execute an explicitly selected Studio Computer agent; older rows
 * may still contain Local's `codex` default, so normalize that legacy value to
 * Pi while preserving the Cloud-only OMP selection.
 */
function normalizeChatSession(session: ChatSession): ChatSession {
  return getRuntimeMode() === 'cloud'
    ? { ...session, agent: normalizedAgent(session.agent, CLOUD_AGENT_KINDS, 'pi'), access_mode: 'restricted' }
    : { ...session, agent: normalizedAgent(session.agent, LOCAL_AGENT_KINDS, 'codex') }
}

async function readChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
  surface?: ChatSessionSurface,
): Promise<ChatSession | null> {
  if (!isChatSessionId(sessionId)) return null

  let query = supabase
    .schema('openlink')
    .from('chat_sessions')
    .select(CHAT_SESSION_SELECT)
    .eq('id', sessionId)
    .eq('user_id', userId)
  if (surface) query = query.eq('surface', surface)
  const { data, error } = await query.maybeSingle()

  if (error) throw error
  if (!data) return null
  const session = data as ChatSession
  // A malformed or legacy row must not become addressable through an unknown
  // surface. The database constraint makes this unreachable in healthy data.
  if (!isChatSessionSurface(session.surface)) return null
  return normalizeChatSession(session)
}

/**
 * Resolve any owned execution session. Shared runtime paths use this only when
 * they explicitly accept both Code and Bot surfaces (for example the desktop
 * gateway or the shared event stream). Product surfaces use the strict
 * accessors below.
 */
export async function getChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<ChatSession | null> {
  return await readChatSession(supabase, userId, sessionId)
}

/**
 * Resolve a session for the Code surface. Bot execution sessions are stored in
 * the same table for recovery and Agent Host routing, but they must never be
 * addressable from Code-mode pages or actions.
 */
export async function getCodeChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<CodeChatSession | null> {
  const session = await readChatSession(supabase, userId, sessionId, 'code')
  return session as CodeChatSession | null
}

/**
 * Resolve a Bot's hidden execution session. Callers must still verify that the
 * `openlink.bots` row maps to this id before granting Bot-scoped access.
 */
export async function getBotChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  sessionId: string,
): Promise<BotChatSession | null> {
  const session = await readChatSession(supabase, userId, sessionId, 'bot')
  return session as BotChatSession | null
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
    .eq('surface', 'code')
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
    .eq('surface', 'code')

  if (error) throw error
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
  const cloudMode = getRuntimeMode() === 'cloud'
  if (cloudMode ? project.status === 'archived' : project.status !== 'active' || project.runtime_status !== 'ready') {
    throw new Error('PROJECT_RUNTIME_NOT_READY')
  }
  const projectId = project.id

  const initialPrompt = options.prompt?.trim().slice(0, 10000) ?? ''
  const title = deriveChatSessionTitle(initialPrompt, t)
  const requestedModel = options.providerId && options.modelId
    ? { providerId: options.providerId, modelId: options.modelId }
    : null
  // Model credentials stay encrypted in OpenLink's provider configuration.
  // Persist only the provider/model selection on the session so Cloud's
  // initial-prompt auto-start and later retries resolve the same app-owned
  // configuration before sending it to the Computer Host.
  const selectedModel = await resolveConfiguredModelSelection(supabase, userId, requestedModel)
  if (!selectedModel) throw new Error('MODEL_CONFIGURATION_REQUIRED')

  const effectiveAgent = cloudMode
    ? normalizedAgent(options.agent, CLOUD_AGENT_KINDS, 'pi')
    : normalizedAgent(options.agent, LOCAL_AGENT_KINDS,
      normalizedAgent(project.default_agent, LOCAL_AGENT_KINDS, DEFAULT_AGENT_KIND))

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
        provider_id: selectedModel?.providerId ?? null,
        model_id: selectedModel?.modelId ?? null,
        agent: effectiveAgent,
        title,
        initial_prompt: initialPrompt,
        access_mode: options.accessMode ?? DEFAULT_ACCESS_MODE,
        surface: 'code',
      })
      .select(CHAT_SESSION_SELECT)
      .single()

    if (!error) return { session: data as ChatSession, workspace: workspace as OpenLinkWorkspace }
    if (error.code !== '23505') throw error
  }

  throw new Error('CHAT_SESSION_ID_CONFLICT')
}

export async function forkChatSession(
  supabase: ServerSupabaseClient,
  userId: string,
  source: CodeChatSession,
): Promise<CodeChatSession> {
  if (source.user_id !== userId) throw new Error('CHAT_SESSION_NOT_FOUND')
  if (source.surface !== 'code') throw new Error('CHAT_SESSION_NOT_FOUND')
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
        surface: 'code',
      })
      .select(CHAT_SESSION_SELECT)
      .single()
    if (!error) return data as CodeChatSession
    if (error.code !== '23505') throw error
  }
  throw new Error('CHAT_SESSION_ID_CONFLICT')
}
