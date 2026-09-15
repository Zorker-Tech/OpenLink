'use server'

import { createChatSession, deleteChatSession, updateChatSessionAccessMode, updateChatSessionTitle, type AccessMode } from '@/lib/chat-sessions'
import type { AgentKind } from '@/lib/chat-session-types'
import { resolveAppEntry } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'
import { getChatSession } from '@/lib/chat-sessions'

export interface CreateChatSessionInput {
  prompt?: string
  workspaceSlug?: string
  projectId?: string | null
  providerId?: string
  modelId?: string
  accessMode?: AccessMode
  agent?: AgentKind
  autoStart?: boolean
}

export type CreateChatSessionResult =
  | { id: string; path: string; fallback: false }
  | { id: null; path: string; fallback: true }
  | { id: null; path: null; fallback: false; error: string }

export async function createChatSessionAction(
  input: CreateChatSessionInput = {},
): Promise<CreateChatSessionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { id: null, path: null, fallback: false, error: 'AUTH_REQUIRED' }
  }

  const prompt = input.prompt?.trim() ?? ''
  let workspaceSlug = input.workspaceSlug?.trim() || undefined

  try {
    if (!workspaceSlug) {
      const entry = await resolveAppEntry(supabase, user)
      if (entry.needsOnboarding || entry.needsOrganizationOnboarding || !entry.workspace) {
        const query = prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''
        return { id: null, path: `/app${query}`, fallback: true }
      }
      workspaceSlug = entry.workspace.slug
    }

    const { session } = await createChatSession(supabase, user.id, {
      prompt,
      workspaceSlug,
      projectId: input.projectId,
      providerId: input.providerId,
      modelId: input.modelId,
      accessMode: input.accessMode,
      agent: input.agent,
    })
    const query = new URLSearchParams()
    if (prompt && input.autoStart !== false) query.set('run', '1')
    const suffix = query.size ? `?${query.toString()}` : ''
    return { id: session.id, path: `/${user.id}/chat/${session.id}${suffix}`, fallback: false }
  } catch (error) {
    return {
      id: null,
      path: null,
      fallback: false,
      error: error instanceof Error ? error.message : 'CHAT_SESSION_CREATE_FAILED',
    }
  }
}

export type UpdateChatSessionTitleResult =
  | { title: string; error: null }
  | { title: null; error: string }

export async function updateChatSessionTitleAction(input: {
  sessionId: string
  title: string
}): Promise<UpdateChatSessionTitleResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { title: null, error: 'AUTH_REQUIRED' }

  try {
    const title = await updateChatSessionTitle(supabase, user.id, input.sessionId, input.title)
    return { title, error: null }
  } catch (error) {
    return {
      title: null,
      error: error instanceof Error ? error.message : 'CHAT_SESSION_UPDATE_FAILED',
    }
  }
}

export type UpdateChatSessionAccessModeResult =
  | { mode: AccessMode; error: null }
  | { mode: null; error: string }

export async function updateChatSessionAccessModeAction(input: {
  sessionId: string
  mode: AccessMode
}): Promise<UpdateChatSessionAccessModeResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { mode: null, error: 'AUTH_REQUIRED' }

  try {
    const mode = await updateChatSessionAccessMode(supabase, user.id, input.sessionId, input.mode)
    return { mode, error: null }
  } catch (error) {
    return {
      mode: null,
      error: error instanceof Error ? error.message : 'CHAT_SESSION_ACCESS_MODE_UPDATE_FAILED',
    }
  }
}

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export interface PendingAccessWrite {
  id: string
  operation: string
  sql: string
  createdAt: string
}

export async function listPendingAccessWritesAction(sessionId: string): Promise<{ confirmations: PendingAccessWrite[]; error: string | null }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { confirmations: [], error: 'AUTH_REQUIRED' }
  const host = agentHostConfig()
  if (!host) return { confirmations: [], error: 'AGENT_HOST_NOT_CONFIGURED' }
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return { confirmations: [], error: 'SESSION_NOT_FOUND' }
  try {
    const response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(session.project_id)}/supabase/mcp/confirmations`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${host.apiToken}`, Accept: 'application/json', 'x-openlink-session-id': sessionId },
      cache: 'no-store',
    })
    if (!response.ok) return { confirmations: [], error: `LIST_FAILED_${response.status}` }
    const payload = await response.json() as { confirmations?: unknown }
    return { confirmations: Array.isArray(payload.confirmations) ? payload.confirmations as PendingAccessWrite[] : [], error: null }
  } catch (error) {
    return { confirmations: [], error: error instanceof Error ? error.message : 'LIST_FAILED' }
  }
}

export async function approveAccessWriteAction(sessionId: string, confirmationId: string): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'AUTH_REQUIRED' }
  const host = agentHostConfig()
  if (!host) return { ok: false, error: 'AGENT_HOST_NOT_CONFIGURED' }
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' }
  try {
    const response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(session.project_id)}/supabase/mcp/confirmations/${encodeURIComponent(confirmationId)}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json', 'x-openlink-session-id': sessionId },
      body: JSON.stringify({ userId: user.id }),
      cache: 'no-store',
    })
    if (!response.ok) return { ok: false, error: `APPROVE_FAILED_${response.status}` }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'APPROVE_FAILED' }
  }
}

export type DeleteChatSessionResult =
  | { ok: true; error: null }
  | { ok: false; error: string }

export async function deleteChatSessionAction(sessionId: string): Promise<DeleteChatSessionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'AUTH_REQUIRED' }

  try {
    await deleteChatSession(supabase, user.id, sessionId)
    return { ok: true, error: null }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'CHAT_SESSION_DELETE_FAILED',
    }
  }
}
