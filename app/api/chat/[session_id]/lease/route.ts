import { getChatSession, isChatSessionId } from '@/lib/chat-sessions'
import { loadPiSessionSnapshot } from '@/lib/chat-session-persistence.server'
import { resolveAgentProviderRuntimeConfiguration } from '@/lib/ai-provider-configurations.server'
import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

function agentHostConfig() {
  const baseUrl = process.env.OPENLINK_AGENT_HOST_URL?.replace(/\/$/, '')
  const apiToken = process.env.OPENLINK_AGENT_API_TOKEN
  return baseUrl && apiToken ? { baseUrl, apiToken } : null
}

/**
 * Declares this chat/project active and ensures its session-bound Agent is
 * fully ready. Repeated calls are cheap keepalives; after a Host restart the
 * same endpoint reattaches the durable Worker before falling back to creation.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ session_id: string }> },
) {
  const { session_id: sessionId } = await params
  if (!isChatSessionId(sessionId)) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })
  const config = agentHostConfig()
  if (!config) return Response.json({ error: 'AGENT_HOST_NOT_CONFIGURED' }, { status: 503 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  const session = await getChatSession(supabase, user.id, sessionId)
  if (!session) return Response.json({ error: 'SESSION_NOT_FOUND' }, { status: 404 })

  let body: { model?: unknown; browserSessionId?: unknown } = {}
  try {
    body = await request.json() as typeof body
  } catch {
    // Empty keepalive requests remain valid and simply touch an existing
    // runtime. The chat page sends the warmup payload when it has a model and
    // (usually) a Browser Host binding available.
  }
  let requestedModel: { providerId: string; modelId: string } | null = session.provider_id && session.model_id
    ? { providerId: session.provider_id, modelId: session.model_id }
    : null
  if (body.model !== undefined) {
    if (!body.model || typeof body.model !== 'object') return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    const candidate = body.model as Record<string, unknown>
    if (typeof candidate.providerId !== 'string' || typeof candidate.modelId !== 'string') return Response.json({ error: 'INVALID_MODEL' }, { status: 400 })
    requestedModel = { providerId: candidate.providerId, modelId: candidate.modelId }
  }
  const browserSessionId = body.browserSessionId === undefined
    ? undefined
    : typeof body.browserSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(body.browserSessionId)
      ? body.browserSessionId
      : null
  if (body.browserSessionId !== undefined && !browserSessionId) return Response.json({ error: 'INVALID_BROWSER_SESSION' }, { status: 400 })

  let runtimeConfiguration
  try {
    runtimeConfiguration = await resolveAgentProviderRuntimeConfiguration(supabase, user.id, requestedModel)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    const safeCode = code === 'PROVIDER_CREDENTIAL_REKEY_REQUIRED'
      ? code
      : code === 'PROVIDER_API_KEY_REQUIRED' || code === 'MODEL_NOT_ENABLED' || code === 'UNKNOWN_PROVIDER_MODEL' || code === 'UNKNOWN_PROVIDER'
        ? code
        : 'MODEL_CONFIGURATION_INVALID'
    return Response.json({ error: safeCode }, { status: 400 })
  }
  if (!runtimeConfiguration) return Response.json({ error: 'MODEL_CONFIGURATION_REQUIRED' }, { status: 400 })

  let nativeSession
  if ((session.agent ?? 'codex') !== 'codex') {
    try {
      nativeSession = await loadPiSessionSnapshot(supabase, user.id, sessionId)
    } catch {
      return Response.json({ error: 'PI_SESSION_READ_FAILED' }, { status: 500 })
    }
  }

  const response = await fetch(`${config.baseUrl}/v1/agent/sessions/${encodeURIComponent(sessionId)}/lease`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      workspaceId: session.workspace_id,
      projectId: session.project_id,
      sessionId,
      runtimeConfiguration,
      agent: session.agent ?? 'codex',
      accessMode: session.access_mode,
      ...(nativeSession ? { nativeSession } : {}),
      ...(browserSessionId ? { browserSessionId } : {}),
    }),
    cache: 'no-store',
    // A mode switch intentionally replaces the session Worker because Codex
    // applies its sandbox/approval policy at process start. Project VM-backed
    // workers can take longer than the old five-second UI keepalive budget.
    signal: AbortSignal.timeout(300_000),
  })
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } })
}
