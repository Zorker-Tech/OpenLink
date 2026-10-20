import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function hostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return null
  return { baseUrl, apiToken }
}

export async function POST(request: Request) {
  const config = hostConfig()
  if (!config) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED' } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })

  let body: { chatSessionId?: unknown }
  try { body = await request.json() as typeof body } catch {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 })
  }
  const chatSessionId = typeof body.chatSessionId === 'string' ? body.chatSessionId : ''
  if (!isChatSessionId(chatSessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  const chat = await getChatSession(supabase, user.id, chatSessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const response = await fetch(`${config.baseUrl}/v1/agent/sessions/${encodeURIComponent(chatSessionId)}/desktop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      workspaceId: chat.workspace_id,
      projectId: chat.project_id,
      sessionId: chatSessionId,
    }),
    cache: 'no-store',
  })
  return new Response(response.body, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Referrer-Policy': 'no-referrer' },
  })
}
