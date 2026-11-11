import { getCodeChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { effectiveChatSessionRunStatus, getChatSessionRun } from '@/lib/chat-session-runs.server'
import { listPersistedChatEvents } from '@/lib/chat-session-persistence.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getCodeChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const url = new URL(request.url)
  const sinceValue = Number(url.searchParams.get('since') ?? '-1')
  const since = Number.isSafeInteger(sinceValue) && sinceValue >= -1 ? sinceValue : -1
  try {
    const [run, events] = await Promise.all([
      getChatSessionRun(supabase, user.id, sessionId),
      listPersistedChatEvents(supabase, user.id, sessionId),
    ])
    const effectiveRun = run && effectiveChatSessionRunStatus(run) === 'interrupted'
      ? { ...run, status: 'failed' as const, errorCode: 'PROCESS_INTERRUPTED', finishedAt: run.heartbeatAt }
      : run
    return Response.json({
      run: effectiveRun,
      events: since < 0 ? events : events.filter((event) => event.sequence > since),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'SESSION_RUN_READ_FAILED' }, { status: 500 })
  }
}
