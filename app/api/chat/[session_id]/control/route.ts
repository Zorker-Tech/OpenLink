import { deleteChatSession, forkChatSession, getChatSession, isChatSessionId, type ChatSession } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'
import { forkPersistedChatEvents, parsePiSessionDelta, persistPiSessionDelta } from '@/lib/chat-session-persistence.server'
import { cloudComputerHostRequest } from '@/lib/platform-cloud-host.server'
import { getRuntimeMode } from '@/lib/runtime-mode.server'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const body = await request.json().catch(() => null) as { action?: unknown; text?: unknown } | null
  if (!body || typeof body.action !== 'string' || !['status', 'interrupt', 'pause', 'resume', 'steer', 'follow-up', 'plan', 'default', 'goal', 'goal-clear', 'compact', 'fork'].includes(body.action)
    || (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 100000))) return Response.json({ error: 'INVALID_BODY' }, { status: 400 })
  if ((body.action === 'steer' || body.action === 'follow-up' || body.action === 'goal') && (typeof body.text !== 'string' || !body.text.trim())) return Response.json({ error: 'TEXT_REQUIRED' }, { status: 400 })
  if (body.action === 'goal' && (body.text as string).length > 4000) return Response.json({ error: 'GOAL_TOO_LONG' }, { status: 400 })
  if (session.agent !== 'codex' && ['plan', 'default', 'goal', 'goal-clear'].includes(body.action)) return Response.json({ error: 'CONTROL_UNSUPPORTED' }, { status: 400 })
  if (body.action === 'fork' && session.agent !== 'codex') return Response.json({ error: 'CONTROL_UNSUPPORTED' }, { status: 400 })
  if (getRuntimeMode() === 'cloud') {
    try {
      const response = await cloudComputerHostRequest(`/v1/agent/sessions/${sessionId}/control`, {
        ...body,
        sessionId,
        userId: user.id,
        workspaceId: session.workspace_id,
        projectId: session.project_id,
      }, AbortSignal.timeout(body.action === 'interrupt' ? 130_000 : 35_000))
      const payload = await response.json().catch(() => null)
      const safeErrors = new Set(['SESSION_BUSY', 'AGENT_SESSION_NOT_ACTIVE', 'CONTROL_UNSUPPORTED', 'AGENT_CONTROL_UNAVAILABLE', 'AGENT_CANCEL_UNAVAILABLE'])
      if (!response.ok) return Response.json({ error: safeErrors.has(payload?.error) ? payload.error : 'AGENT_CONTROL_FAILED' }, { status: response.status })
      return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return Response.json({ error: 'AGENT_CONTROL_UNAVAILABLE' }, { status: 502 })
    }
  }
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const token = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !token) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })
  let forkedSession: ChatSession | null = null
  try {
    if (body.action === 'fork') {
      forkedSession = await forkChatSession(supabase, user.id, session)
      await forkPersistedChatEvents(supabase, user.id, session.id, forkedSession.id)
    }
    const response = await fetch(`${baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/control`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(forkedSession ? { targetSessionId: forkedSession.id } : {}), sessionId, userId: user.id, workspaceId: session.workspace_id, projectId: session.project_id }),
      signal: AbortSignal.timeout(body.action === 'fork' ? 130_000 : 35_000), cache: 'no-store',
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      if (forkedSession) await deleteChatSession(supabase, user.id, forkedSession.id).catch(() => undefined)
      return Response.json({ error: 'AGENT_CONTROL_FAILED' }, { status: response.status })
    }
    if (session.agent === 'pi' && payload?.result?.nativeSession) {
      const delta = parsePiSessionDelta(payload.result.nativeSession)
      if (delta) await persistPiSessionDelta(supabase, user.id, sessionId, delta)
      delete payload.result.nativeSession
    }
    return Response.json({ ...payload, ...(forkedSession ? { fork: { id: forkedSession.id, path: `/${user.id}/chat/${forkedSession.id}` } } : {}) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    if (forkedSession) await deleteChatSession(supabase, user.id, forkedSession.id).catch(() => undefined)
    return Response.json({ error: 'AGENT_CONTROL_UNAVAILABLE' }, { status: 502 })
  }
}
