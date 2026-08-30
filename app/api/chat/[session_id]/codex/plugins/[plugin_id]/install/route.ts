import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { installCodexPlugin, listCodexPlugins, listCodexSkills } from '@/lib/codex-marketplace.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function POST(_request: Request, { params }: { params: Promise<{ session_id: string; plugin_id: string }> }) {
  const { session_id: sessionId, plugin_id: pluginId } = await params
  if (!isChatSessionId(sessionId) || pluginId.length > 240) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (session.agent !== 'codex') return Response.json({ error: 'CODEX_AGENT_REQUIRED' }, { status: 409 })
  try {
    await installCodexPlugin(pluginId)
    const [skills, plugins] = await Promise.all([listCodexSkills(), listCodexPlugins()])
    return Response.json({ skills, plugins }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CODEX_PLUGIN_INSTALL_FAILED'
    const statusCode = code === 'CODEX_PLUGIN_NOT_FOUND' ? 404 : code === 'CODEX_PLUGIN_INSTALL_NOT_ALLOWED' ? 403 : 502
    return Response.json({ error: code }, { status: statusCode })
  }
}
