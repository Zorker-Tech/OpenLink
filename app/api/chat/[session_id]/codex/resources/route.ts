import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { listCodexPlugins, listCodexSkills } from '@/lib/codex-marketplace.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  if (session.agent !== 'codex') return Response.json({ error: 'CODEX_AGENT_REQUIRED' }, { status: 409 })
  try {
    const [skills, plugins] = await Promise.all([listCodexSkills(), listCodexPlugins()])
    return Response.json({ skills, plugins }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ error: 'CODEX_PLUGIN_CATALOG_UNAVAILABLE' }, { status: 503 })
  }
}
