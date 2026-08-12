import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

function parseBody(value: unknown): { hosts: string[]; mode: 'temporary' | 'persistent'; durationSeconds?: number } {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BODY')
  const body = value as Record<string, unknown>
  if (!Array.isArray(body.hosts) || body.hosts.length < 1 || body.hosts.length > 32) throw new Error('INVALID_BODY')
  const hosts = body.hosts.map((host) => typeof host === 'string' ? host.trim().toLowerCase() : '')
  if (hosts.some((host) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || host.includes('..'))) throw new Error('INVALID_BODY')
  const mode = body.mode === 'temporary' || body.mode === 'persistent' ? body.mode : ''
  if (!mode) throw new Error('INVALID_BODY')
  const durationSeconds = body.durationSeconds === undefined ? 900 : Number(body.durationSeconds)
  if (mode === 'temporary' && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3_600)) throw new Error('INVALID_BODY')
  return { hosts: [...new Set(hosts)], mode, ...(mode === 'temporary' ? { durationSeconds } : {}) }
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

  let body: ReturnType<typeof parseBody>
  try { body = parseBody(await request.json()) } catch { return Response.json({ error: 'INVALID_BODY' }, { status: 400 }) }

  let upstream: Response
  try {
    upstream = await fetch(`${host.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/network-access`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, workspaceId: session.workspace_id, hosts: body.hosts, mode: body.mode, durationSeconds: body.durationSeconds }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return Response.json({ error: 'AGENT_HOST_UNAVAILABLE', retryable: true }, { status: 502 })
  }
  const payload = await upstream.json().catch(() => null)
  return Response.json(payload ?? { error: 'NETWORK_ACCESS_FAILED' }, { status: upstream.status, headers: { 'Cache-Control': 'no-store' } })
}
