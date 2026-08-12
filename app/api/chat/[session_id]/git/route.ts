import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

async function getAuthenticatedChat(sessionId: string) {
  if (!isChatSessionId(sessionId)) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 }) }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }) }
  const chat = await getChatSession(supabase, user.id, sessionId)
  if (!chat) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 }) }
  return { user, chat }
}

async function proxyGitRequest(
  request: Request,
  sessionId: string,
  method: 'GET' | 'POST',
) {
  const host = agentHostConfig()
  if (!host) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED', retryable: true } }, { status: 503 })
  const authenticated = await getAuthenticatedChat(sessionId)
  if ('response' in authenticated) return authenticated.response

  const url = `${host.baseUrl}/v1/projects/${encodeURIComponent(authenticated.chat.project_id)}/git/${method === 'GET' ? 'versions' : 'checkout'}`
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${host.apiToken}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(await request.json().catch(() => ({}))) } : {}),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({ error: { code: 'GIT_REQUEST_FAILED' } }))
  return Response.json(payload, { status: response.status })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  return proxyGitRequest(new Request('http://localhost'), sessionId, 'GET')
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  return proxyGitRequest(request, sessionId, 'POST')
}
