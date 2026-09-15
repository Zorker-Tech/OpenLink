import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { installCodexPlugin, listCodexPlugins, listCodexSkills } from '@/lib/codex-marketplace.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

export async function POST(_request: Request, { params }: { params: Promise<{ session_id: string; plugin_id: string }> }) {
  const { session_id: sessionId, plugin_id: pluginId } = await params
  if (!isChatSessionId(sessionId) || pluginId.length > 240) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  if (session.agent !== 'codex') return Response.json({ error: 'CODEX_AGENT_REQUIRED' }, { status: 409 })
  const host = agentHostConfig()
  if (!host) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })
  try {
    await installCodexPlugin(pluginId)
    const invalidated = await fetch(`${host.baseUrl}/v1/agent/plugins/invalidate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.apiToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!invalidated.ok) throw new Error('CODEX_PLUGIN_RUNTIME_REFRESH_FAILED')
    const [skills, plugins] = await Promise.all([listCodexSkills(), listCodexPlugins()])
    return Response.json({ skills, plugins }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : ''
    const code = ['CODEX_PLUGIN_NOT_FOUND', 'CODEX_PLUGIN_INSTALL_NOT_ALLOWED', 'CODEX_PLUGIN_RUNTIME_REFRESH_FAILED'].includes(rawCode)
      ? rawCode
      : 'CODEX_PLUGIN_INSTALL_FAILED'
    const statusCode = code === 'CODEX_PLUGIN_NOT_FOUND' ? 404 : code === 'CODEX_PLUGIN_INSTALL_NOT_ALLOWED' ? 403 : 502
    return Response.json({ error: code }, { status: statusCode })
  }
}
