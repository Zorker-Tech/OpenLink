'use server'

import { createChatSession, updateChatSessionTitle } from '@/lib/chat-sessions'
import { resolveAppEntry } from '@/lib/workspaces'
import { createClient } from '@/utils/supabase/server'

export interface CreateChatSessionInput {
  prompt?: string
  workspaceSlug?: string
  projectId?: string | null
  providerId?: string
  modelId?: string
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
    })
    const query = new URLSearchParams()
    if (prompt) query.set('run', '1')
    const suffix = query.size ? `?${query.toString()}` : ''
    return { id: session.id, path: `/${user.id}/cchat/${session.id}${suffix}`, fallback: false }
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
