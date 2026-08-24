import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
    const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
    const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
    return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

async function getAuthenticatedChat(sessionId: string) {
    if (!isChatSessionId(sessionId)) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 }) }
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { response: Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }) }
    const chat = await getChatSession(supabase, user.id, sessionId)
    if (!chat) return { response: Response.json({ error: { code: 'SESSION_NOT_FOUND' } }, { status: 404 }) }
    return { user, chat }
}

// Forwards the safe, publishable Project Supabase connection material for the
// chat session's project. The agent-host endpoint only ever returns the
// publishable/anon key and revision (never the service-role key or DB
// password), so the browser receives exactly what the in-VM app and the Agent
// worker receive: enough to call Auth/REST/Realtime/Storage, nothing more.
// Per-user scoping is enforced here via getChatSession, which only resolves
// chats the authenticated user owns.
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ session_id: string }> },
) {
    const { session_id: sessionId } = await params
    const host = agentHostConfig()
    if (!host) return Response.json({ error: { code: 'AGENT_HOST_NOT_CONFIGURED', retryable: true } }, { status: 503 })
    const authenticated = await getAuthenticatedChat(sessionId)
    if ('response' in authenticated) return authenticated.response

    const url = `${host.baseUrl}/v1/projects/${encodeURIComponent(authenticated.chat.project_id)}/supabase`
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${host.apiToken}` },
        cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({ error: { code: 'SUPABASE_REQUEST_FAILED' } }))
    return Response.json(payload, { status: response.status })
}
