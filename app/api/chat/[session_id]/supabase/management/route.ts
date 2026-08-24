import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

const operations = new Set(['tables', 'database', 'query', 'auth-users', 'storage-buckets', 'functions', 'realtime', 'services', 'logs'])

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  const host = agentHostConfig()
  if (!host) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED', retryable: true } }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const chat = await getChatSession(supabase, user.id, sessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.operation !== 'string' || !operations.has(body.operation)) {
    return Response.json({ error: { code: 'INVALID_BODY' } }, { status: 400 })
  }
  if (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 12_000)) {
    return Response.json({ error: { code: 'INVALID_QUERY' } }, { status: 400 })
  }
  if (body.service !== undefined && (typeof body.service !== 'string' || !/^[a-z0-9-]{1,63}$/.test(body.service))) {
    return Response.json({ error: { code: 'INVALID_SERVICE' } }, { status: 400 })
  }

  let response: Response
  try {
    response = await fetch(`${host.baseUrl}/v1/projects/${encodeURIComponent(chat.project_id)}/supabase/management`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: body.operation,
        ...(body.query !== undefined ? { query: body.query } : {}),
        ...(body.service !== undefined ? { service: body.service } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    })
  } catch {
    return Response.json({ error: { code: 'PROJECT_BACKEND_UNAVAILABLE', retryable: true } }, { status: 503 })
  }
  const payload = await response.json().catch(() => ({ error: { code: 'SUPABASE_MANAGEMENT_REQUEST_FAILED' } }))
  return Response.json(payload, { status: response.status })
}
