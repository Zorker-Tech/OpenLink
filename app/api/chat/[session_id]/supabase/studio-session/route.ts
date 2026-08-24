import { createLocalStudioSession, localStudioCookieName, localStudioOrigin } from '@/lib/local-studio-proxy.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  if (!isLocalRuntime()) return Response.json({ error: { code: 'LOCAL_STUDIO_UNAVAILABLE' } }, { status: 404 })
  const origin = localStudioOrigin(request)
  if (!origin) return Response.json({ error: { code: 'LOCAL_STUDIO_REQUIRES_LOCALHOST' } }, { status: 409 })
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const chat = await getChatSession(supabase, user.id, sessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const session = createLocalStudioSession({ projectId: chat.project_id, chatSessionId: chat.id, userId: user.id })
  const response = Response.json({ iframeUrl: `${origin}/` })
  // `localhost` is intentionally shared with `studio.localhost`, which is a
  // Local-only virtual host handled by this same Next BFF process. The cookie
  // contains a scoped, short-lived HMAC capability, never a Supabase secret.
  response.headers.append('Set-Cookie', `${localStudioCookieName()}=${session.value}; Max-Age=${session.maxAge}; Domain=localhost; Path=/; HttpOnly; SameSite=Strict`)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

