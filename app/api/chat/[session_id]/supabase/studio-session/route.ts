import { createLocalStudioSession, localStudioCookieName, localStudioOrigin, LOCAL_STUDIO_TICKET_PARAM } from '@/lib/local-studio-proxy.server'
import { isLocalRuntime } from '@/lib/runtime-mode.server'
import { getCodeChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  if (!isLocalRuntime()) return Response.json({ error: { code: 'LOCAL_STUDIO_UNAVAILABLE' } }, { status: 404 })
  // The ticket is signed and user/project scoped, so Studio can be used from
  // the same LAN host as the application. The origin always follows the
  // request host; it is never taken from an untrusted query parameter.
  const origin = localStudioOrigin(request)
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const chat = await getCodeChatSession(supabase, user.id, sessionId)
  if (!chat) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })

  const session = createLocalStudioSession({ projectId: chat.project_id, chatSessionId: chat.id, userId: user.id })
  // Chromium never sends `Domain=localhost` cookies to `studio.localhost`, so
  // the first iframe navigation carries the capability as a ticket parameter;
  // the internal route validates it and upgrades it to a host-only cookie on
  // the Studio origin. The Domain=localhost cookie stays as a best-effort
  // fallback for engines that do apply it to subdomains.
  const response = Response.json({ iframeUrl: `${origin}/?${LOCAL_STUDIO_TICKET_PARAM}=${session.value}` })
  // Cookies ignore ports. A host-only cookie from the app port is therefore
  // available to the Studio port on the same hostname (localhost or LAN IP).
  response.headers.append('Set-Cookie', `${localStudioCookieName()}=${session.value}; Max-Age=${session.maxAge}; Path=/; HttpOnly; SameSite=Strict`)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

