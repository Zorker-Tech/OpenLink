import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const token = process.env.OPENLINK_AGENT_API_TOKEN
  if (!baseUrl || !token) return Response.json({ items: [] }, { status: 503 })
  if ((session.agent ?? 'codex') !== 'codex') return Response.json({ items: [] }, { headers: { 'Cache-Control': 'no-store' } })
  let runtimeConfiguration
  try {
    runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(
      supabase,
      user.id,
      session.provider_id && session.model_id
        ? { providerId: session.provider_id, modelId: session.model_id }
        : null,
    )
  } catch {
    return Response.json({ items: [], error: 'MODEL_CONFIGURATION_INVALID' }, { status: 400 })
  }
  if (!runtimeConfiguration) return Response.json({ items: [], error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })
  const searchParams = new URL(request.url).searchParams
  const scope = searchParams.get('scope')
  if (scope !== 'command' && scope !== 'mention' && scope !== 'skill') return Response.json({ error: 'INVALID_SCOPE' }, { status: 400 })
  const query = searchParams.get('query')?.trim().slice(0, 160) ?? ''
  const command = searchParams.get('command')?.trim().slice(0, 80)
  const upstreamParams = new URLSearchParams({ scope, query })
  if (command !== undefined) upstreamParams.set('command', command)
  const response = await fetch(`${baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/resources?${upstreamParams}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      workspaceId: session.workspace_id,
      projectId: session.project_id,
      sessionId,
      runtimeConfiguration,
      agent: 'codex',
      accessMode: session.access_mode,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(90_000),
  })
  const payload = await response.json().catch(() => ({ items: [] })) as { items?: unknown }
  const allowedTypes = new Set(['skill', 'plugin', 'app', 'file', 'thread', 'model', 'mode', 'mcp', 'permission'])
  const items = Array.isArray(payload.items) ? payload.items.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.type !== 'string' || !allowedTypes.has(item.type) || typeof item.label !== 'string' || typeof item.insertText !== 'string' || typeof item.group !== 'string') return []
    return [{
      id: item.id.slice(0, 512),
      type: item.type,
      label: item.label.slice(0, 256),
      description: typeof item.description === 'string' ? item.description.slice(0, 512) : '',
      ...(typeof item.secondaryContent === 'string' ? { secondaryContent: item.secondaryContent.slice(0, 160) } : {}),
      insertText: item.insertText.slice(0, 512),
      group: item.group.slice(0, 80),
      ...(typeof item.command === 'string' ? { command: item.command.slice(0, 80) } : {}),
      ...(typeof item.path === 'string' ? { path: item.path.slice(0, 2_048) } : {}),
    }]
  }) : []
  return Response.json({ items: items.slice(0, 80) }, {
    status: response.ok ? 200 : response.status,
    headers: { 'Cache-Control': 'no-store' },
  })
}
