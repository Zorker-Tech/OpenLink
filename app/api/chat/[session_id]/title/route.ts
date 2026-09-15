import { createClient } from '@/utils/supabase/server'
import { deriveChatSessionTitle, getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { findFirstPersistedUserMessage } from '@/lib/chat-session-persistence.server'

export const runtime = 'nodejs'

// A separate request: title latency/failure never holds the message stream.
export async function POST(_request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: id } = await params
  if (!isChatSessionId(id)) return Response.json({ title: null }, { status: 404 })
  const db = await createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return Response.json({ title: null }, { status: 401 })
  const session = await getChatSession(db, user.id, id)
  if (!session) return Response.json({ title: null }, { status: 404 })
  if (session.agent !== 'codex' || session.title !== deriveChatSessionTitle(session.initial_prompt)) {
    return Response.json({ title: session.title })
  }
  const host = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const token = process.env.OPENLINK_AGENT_API_TOKEN
  if (!host || !token) return Response.json({ title: null })
  try {
    const first = await findFirstPersistedUserMessage(db, user.id, id)
    if (!first || first.type !== 'message.user') return Response.json({ title: null })
    const query = new URLSearchParams({ scope: 'title' })
    const response = await fetch(`${host}/v1/agent/sessions/${encodeURIComponent(id)}/resources?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // No runtimeConfiguration: metadata must not provision another Worker.
      body: JSON.stringify({ userId: user.id, workspaceId: session.workspace_id, projectId: session.project_id, sessionId: id, titlePrompt: first.text.slice(0, 4000) }),
      signal: AbortSignal.timeout(45_000), cache: 'no-store',
    })
    if (!response.ok) return Response.json({ title: null })
    const payload = await response.json() as { title?: unknown }
    if (typeof payload.title !== 'string' || !payload.title.trim()) return Response.json({ title: null })
    const title = Array.from(payload.title.replace(/\s+/g, ' ').trim()).slice(0, 36).join('')
    const { data, error } = await db.schema('openlink').from('chat_sessions')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', user.id)
      // Compare-and-swap also protects a concurrent manual rename back to
      // exactly the temporary title, or a newer message touching the session.
      .eq('title', session.title).eq('updated_at', session.updated_at)
      .select('title').maybeSingle()
    if (error) throw error
    return Response.json({ title: data?.title ?? null })
  } catch {
    console.warn('OpenLink automatic title unavailable; keeping existing title')
    return Response.json({ title: null })
  }
}
