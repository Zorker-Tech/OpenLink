import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ browser_session_id: string }> },
) {
  const baseUrl = process.env.OPENLINK_BROWSER_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_BROWSER_API_TOKEN
  if (!baseUrl || !apiToken) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED' } }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const chatSessionId = new URL(request.url).searchParams.get('chatSessionId') || ''
  if (!isChatSessionId(chatSessionId) || !await getChatSession(supabase, user.id, chatSessionId)) {
    return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  }
  const { browser_session_id: browserSessionId } = await params
  const stateResponse = await fetch(`${baseUrl}/v1/browser/sessions/${encodeURIComponent(browserSessionId)}`, {
    headers: { Authorization: `Bearer ${apiToken}` }, cache: 'no-store',
  })
  if (stateResponse.status === 404) return new Response(null, { status: 204 })
  if (!stateResponse.ok) return Response.json({ error: { code: 'BROWSER_HOST_UNAVAILABLE' } }, { status: 502 })
  const state = await stateResponse.json() as { session?: { ownerId?: string } }
  if (state.session?.ownerId !== user.id) return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  const response = await fetch(`${baseUrl}/v1/browser/sessions/${encodeURIComponent(browserSessionId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` }, cache: 'no-store',
  })
  return new Response(response.body, { status: response.status })
}
