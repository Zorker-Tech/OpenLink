import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function parseBody(value: unknown): { id: string; approved?: boolean; value?: string } {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BODY')
  const body = value as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : ''
  const approved = body.approved
  const text = body.value
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error('INVALID_BODY')
  if (approved !== undefined && typeof approved !== 'boolean') throw new Error('INVALID_BODY')
  if (text !== undefined && (typeof text !== 'string' || text.length > 100_000)) throw new Error('INVALID_BODY')
  if (approved === undefined && text === undefined) throw new Error('INVALID_BODY')
  if (approved !== undefined && text !== undefined) throw new Error('INVALID_BODY')
  return { id, ...(approved !== undefined ? { approved } : {}), ...(text !== undefined ? { value: text } : {}) }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })
  const host = agentHostConfig()
  if (!host) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  let body: { id: string; approved?: boolean; value?: string }
  try {
    body = parseBody(await request.json())
  } catch {
    return Response.json({ error: 'INVALID_BODY' }, { status: 400 })
  }

  const workerResponse = body.approved === true
    ? { confirmed: true }
    : body.approved === false
      ? { cancelled: true }
      : { value: body.value! }
  let upstream: Response
  try {
    upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/extension-ui-response`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: user.id,
        workspaceId: session.workspace_id,
        projectId: session.project_id,
        sessionId,
        id: body.id,
        ...workerResponse,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
  } catch {
    return Response.json({ error: 'AGENT_HOST_UNAVAILABLE', retryable: true }, { status: 502 })
  }
  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => null) as { error?: { code?: unknown; retryable?: unknown } } | null
    const code = typeof payload?.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.error.code)
      ? payload.error.code
      : 'EXTENSION_UI_RESPONSE_FAILED'
    return Response.json({ error: code, retryable: payload?.error?.retryable === true }, { status: upstream.status || 502 })
  }
  return Response.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}
