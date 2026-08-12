import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export async function POST(request: Request) {
  const host = agentHostConfig()
  if (!host) return Response.json({ error: { code: 'CODE_SERVER_NOT_CONFIGURED' } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })

  let body: { chatSessionId?: unknown }
  try {
    body = await request.json() as { chatSessionId?: unknown }
  } catch {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 })
  }
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : ''
  if (!isChatSessionId(chatSessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  // The browser can name any chat id, so derive both Project and Workspace
  // from the authenticated server-side session row instead of trusting it.
  const chat = await getChatSession(supabase, user.id, chatSessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(chat.project_id)}/code-server/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${host.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ownerId: user.id, workspaceId: chat.workspace_id }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({ error: { code: 'CODE_SERVER_SESSION_FAILED' } }))
  return Response.json(payload, { status: response.status })
}
