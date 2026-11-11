import { handleChatSessionEvents } from '@/lib/chat-session-events.server'
import { getCodeChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

/**
 * Public Code-mode prompt stream. Bot prompts call the shared engine directly
 * after verifying the Bot-to-session mapping, so this route never accepts a
 * hidden Bot session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'INVALID_SESSION' }, { status: 404 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })

  const session = await getCodeChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  return await handleChatSessionEvents(request, { sessionId, session, userId: user.id })
}
