import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ browser_session_id: string }> },
) {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !apiToken) return Response.json({ error: { code: 'BROWSER_HOST_NOT_CONFIGURED' } }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 })
  const chatSessionId = new URL(request.url).searchParams.get('chatSessionId') || ''
  const chat = isChatSessionId(chatSessionId) ? await getChatSession(supabase, user.id, chatSessionId) : null
  if (!chat) {
    return Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 })
  }
  const { browser_session_id: browserSessionId } = await params
  const response = await fetch(`${baseUrl}/v1/projects/${encodeURIComponent(chat.project_id)}/browser/sessions/${encodeURIComponent(browserSessionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: user.id, workspaceId: chat.workspace_id }),
    cache: 'no-store',
  })
  return new Response(response.body, { status: response.status })
}
