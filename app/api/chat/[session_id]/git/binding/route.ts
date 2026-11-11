import { getCodeChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { getRuntimeMode } from '@/lib/runtime-mode.server'
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
  const chat = await getCodeChatSession(supabase, user.id, sessionId)
  if (!chat) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 }) }
  return { user, chat }
}

function bindingRef(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const binding = (value as Record<string, unknown>).binding
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null
  const ref = (binding as Record<string, unknown>).ref
  return typeof ref === 'string' && /^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  const host = agentHostConfig()
  const authenticated = await getAuthenticatedChat(sessionId)
  if ('response' in authenticated) return authenticated.response
  if (getRuntimeMode() === 'cloud') return Response.json({ binding: null }, { headers: { 'Cache-Control': 'no-store' } })
  if (!host) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED', retryable: true } }, { status: 503 })

  const query = new URLSearchParams({ userId: authenticated.user.id, workspaceId: authenticated.chat.workspace_id })
  try {
    const response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(authenticated.chat.project_id)}/git/session-bindings/${encodeURIComponent(authenticated.chat.id)}?${query}`, {
      headers: { Authorization: `Bearer ${host.apiToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) return Response.json(payload ?? { error: { code: 'GIT_SESSION_BINDING_READ_FAILED' } }, { status: response.status, headers: { 'Cache-Control': 'no-store' } })
    const ref = bindingRef(payload)
    if (payload && (payload as Record<string, unknown>).binding && !ref) {
      return Response.json({ error: { code: 'GIT_SESSION_BINDING_INVALID' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
    return Response.json({ binding: ref ? { ref } : null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: { code: 'GIT_SESSION_BINDING_READ_FAILED', retryable: true } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: { code: 'ORIGIN_NOT_ALLOWED' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const { session_id: sessionId } = await params
  const host = agentHostConfig()
  if (!host) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED', retryable: true } }, { status: 503 })
  const authenticated = await getAuthenticatedChat(sessionId)
  if ('response' in authenticated) return authenticated.response

  const body = await request.json().catch(() => null) as { ref?: unknown } | null
  const ref = typeof body?.ref === 'string' ? body.ref.toLowerCase() : ''
  if (!/^[0-9a-f]{40}$/.test(ref)) return Response.json({ error: { code: 'GIT_REF_INVALID' } }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

  try {
    const response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(authenticated.chat.project_id)}/git/session-bindings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: authenticated.user.id,
        workspaceId: authenticated.chat.workspace_id,
        sessionId: authenticated.chat.id,
        ref,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) return Response.json(payload ?? { error: { code: 'GIT_SESSION_BINDING_FAILED' } }, { status: response.status, headers: { 'Cache-Control': 'no-store' } })
    const boundRef = bindingRef(payload)
    if (!boundRef || boundRef !== ref) return Response.json({ error: { code: 'GIT_SESSION_BINDING_INVALID' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    return Response.json({ binding: { ref: boundRef } }, { status: response.status, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: { code: 'GIT_SESSION_BINDING_FAILED', retryable: true } }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}
